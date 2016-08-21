import Promise from 'promise';
import thenRequest from 'then-request';
import sshpk from 'sshpk';
import SSH from './ssh';

const BASE_URL = 'https://api.digitalocean.com/v2';

let timeoutsDisabled = false;
export function _disableTimeouts() {
  timeoutsDisabled = true;
}


function getDate() {
  return (new Date()).toISOString();
}

export default class DigiatlOcean {
  constructor(token, keypair) {
    this._token = token;
    this._runningPolls = 0;
    this._rateLimit = {
      limit: 5000,
      remaining: 5000,
      reset: Math.floor(Date.now() / 1000),
    };

    const publicKey = sshpk.parseKey(keypair.public);
    this._fingerprint = this.requestJSON('get', '/account/keys/' + publicKey.fingerprint('md5').toString()).then(
      null,
      err => {
        if (err.statusCode !== 404) throw err;
        return this.requestJSON('post', '/account/keys', {
          json: {
            name: 'dnavy-' + getDate(),
            public_key: publicKey.toString('ssh'),
          },
        });
      }
    ).then(() => publicKey.fingerprint('md5').toString());
    this._privateKey = sshpk.parsePrivateKey(keypair.private).toString();
  }
  _timeToRateLimitReset() {
    return Math.max(1000, (this._rateLimit.reset * 1000) - Date.now());
  }
  request(method, path, options) {
    path = path.replace(BASE_URL, '');
    return new Promise((resolve, reject) => {
      const attempt = () => {
        thenRequest(method, BASE_URL + path, {
          ...(options || {}),
          headers: {
            ...(options && options.headers ? options.headers : {}),
            authorization: 'Bearer ' + this._token,
          },
        }).done(res => {
          if (res.headers['ratelimit-limit']) {
            this._rateLimit = {
              limit: res.headers['ratelimit-limit'],
              remaining: res.headers['ratelimit-remaining'],
              reset: res.headers['ratelimit-reset'],
            };
            if (res.statusCode === 429) {
              console.log('Rate limit exceeded, backing off for ' + (this._timeToRateLimitReset() / 1000) + ' seconds');
              if (timeoutsDisabled) return attempt();
              return setTimeout(attempt, this._timeToRateLimitReset());
            }
          }
          resolve(res);
        }, reject);
      };
      attempt();
    });
  }
  requestJSON(method, path, options) {
    return this.request(method, path, options).then(res => {
      return JSON.parse(res.getBody('utf8'));
    });
  }
  getPaged(path, key, filter) {
    return new Promise((resolve, reject) => {
      const result = [];
      const nextPage = (url) => {
        this.requestJSON('get', url).done(response => {
          result.push(...(filter ? response[key].filter(filter) : response[key]));
          if (response.links && response.links.pages && response.links.pages.next) {
            nextPage(response.links.pages.next);
          } else {
            resolve(result);
          }
        }, reject);
      };
      nextPage(path);
    });
  }
  poll(path, isReady, timeout) {
    this._runningPolls++;
    timeout = timeout || (60 * 1000);
    const timeoutEnd = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const poll = (finalAttempt) => {
        this.requestJSON('get', path).then(result => {
          if (isReady(result)) {
            resolve(result);
          } else if (finalAttempt) {
            reject(new Error('Operation timed out after ' + (timeout / 1000) + ' seconds'));
          } else if (Date.now() > timeoutEnd) {
            poll(true);
          } else {
            // poll less frequently for operations that are typically slower
            // poll less frequently if we are running out of rate limit
            const timeToRateLimitReset = this._timeToRateLimitReset();
            // console.log(
            //   this._rateLimit.remaining + ' remaining of ' + this._rateLimit.limit + ' with reset in ' +
            //   (timeToRateLimitReset / 1000) + ' seconds'
            // );
            const remaining = (this._rateLimit.remaining || 1) / this._runningPolls;
            // console.log('backoff: ' + (remaining / 1000));
            if (timeoutsDisabled) return poll();
            setTimeout(() => poll(), (timeout / 60) + (timeToRateLimitReset / remaining));
          }
        }).done(null, reject);
      };
      poll();
    }).finally(() => this._runningPolls--);
  }
  createDroplet({name, size, image}) {
    console.log('create droplet');
    return this._fingerprint.then(fingerprint => {
      return this.requestJSON('POST', '/droplets', {
        json: {
          name,
          region: 'nyc3',
          size,
          image: image.id,
          ssh_keys: [fingerprint],
          backups: false,
          ipv6: false,
        },
      });
    }).then(result => {
      const id = result.droplet.id;
      return this.poll('/droplets/' + id, result => result.droplet.status !== 'new', 4 * 60 * 1000);
    }).then(result => {
      if (result.droplet.status !== 'active') {
        return this.destroyDroplet(result.droplet).then(() => {
          throw new Error(
            'Expected droplet state to go from "new" to "active" but got "' + result.droplet.status + '"'
          );
        });
      }
      return result.droplet;
    });
  }
  connect(droplet, options) {
    const addresses = droplet.networks.v4.filter(n => n.type === 'public');
    if (addresses.length === 0) {
      throw new Error('Could not find the IP address of droplet');
    }
    const connection = new SSH({
      host: addresses[0].ip_address,
      port: 22,
      username: 'root',
      privateKey: this._privateKey,
    }, options);
    return connection.ready.then(() => connection);
  }

  destroyDroplet(droplet) {
    console.log('destroy droplet');
    return this.request('DELETE', '/droplets/' + droplet.id).then(response => {
      if (response.statusCode !== 204) {
        throw new Error('Expected status code 204 while deleting droplet but got ' + response.statusCode);
      }
    });
  }

  runAction(path, action, options) {
    return this.requestJSON(
      'post',
      path + '/actions',
      {json: action},
    ).then(result => {
      const actions = result.actions ? result.actions : [result.action];
      return Promise.all(actions.map(({id}) => {
        return this.poll(
          '/actions/' + id,
          result => result.action.status !== 'in-progress',
          options && options.timeout,
        ).then(result => {
          if (result.action.status !== 'completed') {
            throw new Error(action.type + ' did not complete successfully');
          }
        });
      }));
    }).then(() => {});
  }

  rebuildDroplet(droplet, image) {
    console.log('rebuild droplet');
    return this._runAction('/droplets/' + droplet.id, {type: 'rebuild', image}).then(() => droplet);
  }

  shutdownDroplet(droplet) {
    console.log('shutdown droplet');
    return new Promise((resolve, reject) => {
      const attempt = (attemptNumber) => {
        this.runAction('/droplets/' + droplet.id, {type: 'shutdown'}).then(
          () => {
            return this.poll(
              '/droplets/' + droplet.id,
              result => result.droplet.status === 'off'
            );
          },
        ).done(resolve, err => {
          if (attemptNumber < 3) {
            attempt(attemptNumber + 1);
          } else {
            reject(err);
          }
        });
      };
      attempt(0);
    });
  }
  snapshotDroplet(droplet, name) {
    console.log('snapshot droplet');
    return this._runAction('/droplets/' + droplet.id, {type: 'snapshot', name}, {timeout: 4 * 60 * 1000}).then(() => {
      return new Promise((resolve, reject) => {
        const poll = () => {
          return this.getPaged(
            '/images',
            'images',
            image => image.name === name && image.public === false
          ).then(
            images => {
              if (images.length) {
                resolve(images[0]);
              } else {
                poll();
              }
            }
          );
        };
        poll();
      });
    });
  }
}
