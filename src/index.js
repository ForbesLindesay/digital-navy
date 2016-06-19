import Promise from 'promise';
import sshpk from 'sshpk';
import SSH from './ssh';
import DigitalOcean from './digital-ocean';

let SshImplementation = SSH;
/*eslint-disable */
let getDate = () => (new Date()).toISOString();
/*eslint-enable */

function installNode(ssh, version) {
  return ssh.exec([
    'yum -y update',
    'yum -y groupinstall "Development Tools"',
    'cd ~',
    'wget http://nodejs.org/dist/' + version + '/node-' + version + '-linux-x64.tar.gz',
    'sudo tar --strip-components 1 -xzvf node-v* -C /usr/local',
    'node --version',
  ], {pty: true});
}

class DigitalNavy {
  constructor({token, keypair, name, prepare, maxPoolSize, minPoolSize, workerSize, builderSize}) {
    const client = new DigitalOcean(token);
    this._client = client;
    this._keypair = keypair;
    this._name = name;
    this._workerSize = workerSize || '512mb';
    this._builderSize = builderSize || workerSize || '512mb';

    this._getMaxPoolSize = typeof maxPoolSize === 'function' ? maxPoolSize : () => (maxPoolSize || 2);
    this._getMinPoolSize = typeof minPoolSize === 'function' ? minPoolSize : () => (minPoolSize || 0);
    this._pool = [];
    this._poolSize = 0;
    this._queue = [];

    // Store the ssh key for using when creating droplets
    this._fingerprint = this._getFingerprint();
    this._snapshot = this._buildSnapshot(name, prepare);
    this._updatePool();
    this.ready = Promise.all([this._fingerprint, this._snapshot].concat(this._pool)).then(() => {});
    process.on('beforeExit', () => {
      this._getMinPoolSize = () => 0;
      this._getMaxPoolSize = () => 0;
      this._updatePool();
    });
  }
  // Optionally passed a dirty droplet that is **not** considered part of the current pool
  _updatePool(dirtyDroplet) {
    // Desired size is the number of queued items + the number of in progress items
    let desiredSize = this._queue.length + (this._poolSize - this._pool.length);
    const minSize = this._getMinPoolSize();
    const maxSize = this._getMaxPoolSize();
    if (desiredSize < minSize) {
      desiredSize = minSize;
    }
    if (desiredSize > maxSize) {
      desiredSize = maxSize;
    }
    if (dirtyDroplet) {
      // if our pool is big enough, discard the dirty droplet
      if (desiredSize <= this._poolSize) {
        this._destroyDroplet(dirtyDroplet).done(null, err => {
          console.error('Error Destroying Droplet:');
          console.error(err.stack);
        });
      }
      // if our pool is too small, re-use the dirty droplet
      if (desiredSize > this._poolSize) {
        this._pool.push(this._rebuildDroplet(dirtyDroplet));
        this._poolSize++;
      }
    }
    while (this._poolSize > desiredSize) {
      // take the least ready droplet (i.e. most recently used)
      this._pool.pop().then(droplet => this._destroyDroplet(droplet)).done(null, err => {
        console.error('Error Destroying Droplet:');
        console.error(err.stack);
      });
      this._poolSize--;
    }
    while (this._poolSize < desiredSize) {
      this._pool.push(this._createDroplet({name: 'dnavy-worker-' + this._name, size: this._workerSize}));
      this._poolSize++;
    }
    while (this._queue.length && this._pool.length) {
      const job = this._queue.shift();
      // take the least recently used droplet because it's most likely to already be on and cleaned up
      const droplet = this._pool.shift();
      job(droplet);
    }
  }
  _getFingerprint() {
    const publicKey = sshpk.parseKey(this._keypair.public);
    return this._client.requestJSON('get', '/account/keys/' + publicKey.fingerprint('md5').toString()).then(
      null,
      err => {
        if (err.statusCode !== 404) throw err;
        return this._client.requestJSON('post', '/account/keys', {
          json: {
            name: 'dnavy-' + getDate(),
            public_key: publicKey.toString('ssh'),
          },
        });
      }
    ).then(() => publicKey.fingerprint('md5').toString());
  }

  _buildSnapshot(name, prepare) {
    let d = null;
    return this._client.getPaged(
      '/images',
      'images',
      image => (
        (image.distribution === 'CentOS' && image.public === true && /^\d+\.\d+ x64$/.test(image.name)) ||
        (image.name === name && image.public === false)
      )
    ).then(
      images => images.reduce((current, next) => {
        if (current.name === name) return current;
        if (next.name === name) return next;
        return next.slug > current.slug ? next : current;
      }, images[0])
    ).then(baseImage => {
      if (baseImage.name === name) {
        console.log('reusing existing image ' + name);
        return baseImage;
      }
      return this._createDroplet({
        name: 'dnavy-snapshot-creator-' + name,
        size: this._builderSize,
        image: baseImage,
      }).then(droplet => {
        d = droplet;
        return this._ssh(droplet, ssh => prepare(ssh)).then(
          () => this._shutdownDroplet(droplet)
        ).then(
          () => this._snapshotDroplet(droplet, name)
        );
      }).then(null, err => {
        console.error(err.stack);
      }).finally(() => {
        if (d) return this._destroyDroplet(d);
      });
    });
  }
  _createDroplet({name, size, image}) {
    console.log('create droplet');
    if (!image) {
      image = this._snapshot;
    }
    return Promise.all([
      this._fingerprint,
      image,
    ]).then(([fingerprint, image]) => {
      return this._client.requestJSON('POST', '/droplets', {
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
      return this._client.poll('/droplets/' + id, result => result.droplet.status !== 'new', 4 * 60 * 1000);
    }).then(result => {
      if (result.droplet.status !== 'active') {
        throw new Error(
          'Expected droplet state to go from "new" to "active" but got "' + result.droplet.status + '"'
        );
      }
      return result.droplet;
    });
  }
  _runAction(path, action, options) {
    return this._client.requestJSON(
      'post',
      path + '/actions',
      {json: action},
    ).then(result => {
      const actions = result.actions ? result.actions : [result.action];
      return Promise.all(actions.map(({id}) => {
        return this._client.poll(
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
  _shutdownDroplet(droplet) {
    console.log('shutdown droplet');
    return new Promise((resolve, reject) => {
      const attempt = (attemptNumber) => {
        this._runAction('/droplets/' + droplet.id, {type: 'shutdown'}).then(
          () => {
            return this._client.poll(
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
  _snapshotDroplet(droplet, name) {
    console.log('snapshot droplet');
    return this._runAction('/droplets/' + droplet.id, {type: 'snapshot', name}, {timeout: 4 * 60 * 1000}).then(() => {
      return new Promise((resolve, reject) => {
        const poll = () => {
          return this._client.getPaged(
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
  _rebuildDroplet(droplet) {
    console.log('rebuild droplet');
    return this._snapshot.then(snapshot => {
      return this._runAction('/droplets/' + droplet.id, {type: 'rebuild', image: snapshot.id});
    }).then(() => droplet);
  }
  _destroyDroplet(droplet) {
    console.log('destroy droplet');
    return this._client.request('DELETE', '/droplets/' + droplet.id).then(response => {
      if (response.statusCode !== 204) {
        throw new Error('Expected status code 204 while deleting droplet but got ' + response.statusCode);
      }
    });
  }

  _ssh(droplet, options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = undefined;
    }
    const addresses = droplet.networks.v4.filter(n => n.type === 'public');
    if (addresses.length === 0) {
      throw new Error('Could not find the IP address of droplet');
    }
    const privateKey = sshpk.parsePrivateKey(this._keypair.private);
    const connection = new SshImplementation({
      host: addresses[0].ip_address,
      port: 22,
      username: 'root',
      privateKey: privateKey.toString(),
    }, options);
    return connection.ready.then(() => fn(connection)).finally(() => connection.close());
  }

  run(options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }
    return new Promise((resolve, reject) => {
      this._queue.push(dropletPromise => {
        dropletPromise.then(droplet => {
          return Promise.resolve(null).then(
            () => this._ssh(droplet, {debug: options.debug}, ssh => fn(ssh))
          ).then(
            result => {
              this._poolSize--;
              this._updatePool(droplet);
              return result;
            },
            err => {
              // If anything went wrong, we destroy the droplet just in case the droplet is somehow in a bad state
              this._destroyDroplet(droplet).done(null, err => {
                console.error('Error Destroying Droplet:');
                console.error(err.stack);
              });
              this._poolSize--;
              this._updatePool();
              throw err;
            },
          );
        }).done(resolve, reject);
      });
      // The pool may need to increase in size, or may be big enough to immediately start executing
      this._updatePool();
    });
  }
}

module.exports = DigitalNavy;
DigitalNavy.installNode = installNode;
DigitalNavy._mockSsh = mockSsh => SshImplementation = mockSsh;
DigitalNavy._mockDate = mockDate => getDate = mockDate;
