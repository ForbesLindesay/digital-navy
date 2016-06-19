import assert from 'assert';
import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import rimraf from 'rimraf';
import Promise from 'promise';
import {stringify, parse} from 'json-buffer';
import DigitalNavy from '../src/index';
import SSH from '../src/ssh';

if (process.env.DIGITAL_OCEAN_KEY) {
  rimraf.sync(__dirname + '/recorded-ssh');
  mkdirSync(__dirname + '/recorded-ssh');
}

class SSHRecorder {
  constructor(remote, options) {
    this._id = remote.host;
    const args = [{host: remote.host, port: remote.port, username: remote.port}, options];
    this._record = {
      constructor: args,
      execs: [],
    };
    this._client = new SSH(remote, options);
    this.ready = this._client.ready;
  }

  exec(...args) {
    const action = {args};
    this._record.execs.push(action);
    const result = this._client.exec(...args);
    result.done(result => action.result = result);
    return result;
  }

  close() {
    setTimeout(() => {
      writeFileSync(__dirname + '/recorded-ssh/' + this._id, stringify(this._record));
    }, 0);
    return this._client.close();
  }
}

class SSHReplayer {
  constructor(remote, options) {
    this._id = remote.host;
    const args = [{host: remote.host, port: remote.port, username: remote.port}, options];
    this._record = parse(readFileSync(__dirname + '/recorded-ssh/' + this._id, 'utf8'));
    assert.deepEqual(parse(stringify(args)), this._record.constructor);
    this._index = 0;
    this.ready = Promise.resolve(null);
  }

  exec(...args) {
    const call = this._record.execs[this._index++];
    assert.deepEqual(parse(stringify(args)), call.args);
    return Promise.resolve(call.result);
  }

  close() {
    assert.strictEqual(this._index, this._record.execs.length);
    return Promise.resolve(null);
  }
}
DigitalNavy._mockSsh(process.env.DIGITAL_OCEAN_KEY ? SSHRecorder : SSHReplayer);
