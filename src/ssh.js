import Promise from 'promise';
import SSHConnection from 'ssh2';


// N.B. this file is completely un-tested when unless you provide a value for process.env.DIGITAL_OCEAN_KEY

export default class SSH {
  constructor(remote, options) {
    this._options = options || {};
    this.ready = new Promise((resolve, reject) => {
      const attempt = (attemptNumber) => {
        this._connection = new SSHConnection();
        this._connection.on('error', err => {
          if (attemptNumber < 5) {
            console.log('connection failed, retrying in ' + Math.pow(2, attemptNumber) + ' second(s)');
            setTimeout(() => attempt(attemptNumber + 1), 1000 * Math.pow(2, attemptNumber));
          } else {
            reject(err);
          }
        });
        this._connection.on('ready', resolve);
        this._connection.connect(remote);
      };
      attempt(0);
    });
  }

  exec(commands, options = {}) {
    if (Array.isArray(commands)) commands = commands.join(' && ');
    const debug = (options.debug === undefined ? this._options.debug : options.debug) || false;

    if (debug) {
      console.log('ssh-exec: ' + commands);
    }

    const result = this.ready.then(() => {
      return new Promise((resolve, reject) => {
        let exitCode = 1;
        this._connection.exec(commands, {pty: options.pty}, (err, stream) => {
          if (err) return reject(err);
          let stream_output = '';
          let err_output = '';
          stream.on('data', (data) => {
            stream_output += data.toString();
            if (debug) {
              process.stdout.write(data);
            }
          });
          stream.stderr.on('data', (data) => {
            err_output += data.toString();
            if (debug) {
              process.stderr.write(data);
            }
          });
          let pending = 3;
          function onEnd() {
            if (--pending === 0) {
              if (exitCode === 0) {
                resolve(stream_output);
              } else {
                reject(new Error(
                  'Command existed with code ' + exitCode + ':\n\n' + stream_output + '\n\n' + err_output
                ));
              }
            }
          }
          stream.on('end', () => {
            if (debug) {
              console.log('stdout end');
            }
            onEnd();
          });
          stream.stderr.on('end', () => {
            if (debug) {
              console.log('stderr end');
            }
            onEnd();
          });
          stream.on('exit', code => {
            if (debug) {
              console.log('exit ' + code);
            }
            exitCode = code;
            onEnd();
          });
          if (options.stdin) {
            stream.end(options.stdin);
          }
        });
      });
    });
    this.ready = result.then(null, () => {});
    return result;
  }

  close() {
    const result = this.ready.finally(() => this._connection.end());
    this.ready = Promise.reject(new Error('Cannot interact with a closed connection'));
    return result;
  }
}
