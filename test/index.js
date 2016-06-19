import {readFileSync, writeFileSync} from 'fs';
import assert from 'assert';
import Promise from 'promise';
import shasum from 'shasum';
import keypair from 'keypair';
import './ssh-mock';
import {_disableTimeouts} from '../src/digital-ocean';
import DigitalNavy, {installNode} from '../src';

_disableTimeouts();
DigitalNavy._mockDate(() => '2016-06-19T01:39:40.763Z');

const script = readFileSync(__dirname + '/example-script.js');

let keys = null;
if (process.env.DIGITAL_OCEAN_KEY) {
  keys = keypair();
  writeFileSync(__dirname + '/public-key', keys.public);
} else {
  keys = {
    public: readFileSync(__dirname + '/public-key', 'utf8'),
    // the private key isn't really used when running against mocks so doesn't need to match public key
    private: keypair().private,
  };
}
const navy = new DigitalNavy({
  // Note that the base image is only re-built when the name changes, so we include a shasum of the script and the node
  // version
  name: 'node-' + process.version + '-' + shasum(script),
  prepare(ssh) {
    console.log('installing node');
    // we install the same version of node as we're using locally
    return installNode(ssh, process.version).then(
      () => {
        console.log('installed node');
        // copy the script to the server
        return ssh.exec('cat > ~/example-script.js', {stdin: script});
      }
    );
  },
  token: process.env.DIGITAL_OCEAN_KEY || 'DIGITAL_OCEAN_KEY',
  keypair: keys,
  // You can use functions here if you want to have these change over time
  // changes in the return values of those functions will only be taken into
  // account when droplets start or stop executing
  minPoolSize: 3,
  maxPoolSize: 4,
});

function run() {
  return navy.run(
    ssh => {
      console.log('got droplet');
      return ssh.exec('node ~/example-script.js').then(
        result => {
          console.log('finished script');
          console.dir(result);
          assert(result === 'Hello World\n');
          return result;
        },
      );
    }
  );
}

// You don't have to wait for the navy to be ready, but I do it here so that we can see timing for a fully initialized
// pool of workers
navy.ready.done(() => {
  const start = Date.now();
  Promise.all([run(), run(), run(), run(), run()]).done(
    result => {
      const end = Date.now();
      console.dir(result);
      console.log('Script executed in ' + ((end - start) / 1000) + ' seconds');
    }
  );
});
