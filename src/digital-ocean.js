import Promise from 'promise';
import thenRequest from 'then-request';

const BASE_URL = 'https://api.digitalocean.com/v2';

let timeoutsDisabled = false;
export function _disableTimeouts() {
  timeoutsDisabled = true;
}

export default class DigiatlOcean {
  constructor(token) {
    this._token = token;
    this._runningPolls = 0;
    this._rateLimit = {
      limit: 5000,
      remaining: 5000,
      reset: Math.floor(Date.now() / 1000),
    };
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
}
