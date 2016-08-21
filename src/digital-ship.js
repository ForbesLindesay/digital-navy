import Promise from 'promise';
import Set from 'es6-set';

const ships = new Set();
process.on('beforeExit', () => {
  ships.forEach(ship => {
    ship.dispose();
  });
});

export default class DigitalShip {
  constructor(client, {name, size, image, behaviour}) {
    this._dirty = false;
    this._disposed = false;
    this._image = image;
    this._client = client;
    this._droplet = client.createDroplet({name, size, image});
    this._ssh = this._droplet.then(droplet => client.connect(droplet));
    this._behaviour = behaviour || (ssh => fn => fn(ssh));
    this._runner = this._ssh.then(ssh => this._behaviour(ssh));
    this.ready = this._runner.then(() => {});
    ships.add(this);
  }
  run(...args) {
    if (this._disposed) {
      return Promise.reject(new Error('Cannot call DigitalShip.run(...args) on disposed ship'));
    }
    if (this._dirty) {
      return Promise.reject(new Error('Cannot call DigitalShip.run(...args) on dirty ship'));
    }
    this._dirty = true;
    return this._runner.then(run => run(...args));
  }
  reset() {
    if (this._disposed) {
      return Promise.reject(new Error('Cannot call DigitalShip.reset(...args) on disposed ship'));
    }
    // Rebuild
    this._droplet = this._runner.then(
      () => this._ssh,
    ).then(
      ssh => ssh.close(),
    ).then(
      () => this._droplet,
    ).then(
      droplet => this._client.rebuild(droplet, this._image),
    );
    // Reconnect
    this._ssh = this._droplet.then(droplet => this._client.connect(droplet));
    this._runner = this._ssh.then(ssh => this._behaviour(ssh));
    this.ready = this._runner.then(() => {});
    this._dirty = false;
    return this;
  }
  dispose() {
    if (this._disposed) {
      return Promise.reject(new Error('Cannot call DigitalShip.dispose(...args) on an already disposed ship'));
    }
    this._disposed = true;
    ships.delete(this);
    this._runner.then(
      () => this._ssh,
    ).then(
      ssh => ssh.close(),
    ).then(
      () => this._droplet,
      err => {
        console.error('Failed to disconnect from droplet');
        console.error(err.stack);
        return this._droplet;
      },
    ).then(
      droplet => this._client.destroy(droplet)
    );
  }
}
