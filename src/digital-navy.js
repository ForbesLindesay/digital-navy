import Promise from 'promise';
import DigitalOcean from './digital-ocean';
import DigitalShip from './digital-ship';
import buildSnapshot from './build-snapshot';


class DigitalNavy {
  constructor(buildShip, {maxShips = 2, minSpareShips = 0}) {
    this._buildShip = buildShip;
    this._maxShips = maxShips;
    this._minSpareShips = minSpareShips;

    this._pool = [];
    this._queue = [];
    this._poolSize = 0;

    this.ready = Promise.all(this._pool.map(ship => ship.ready));
  }
  _inProgress() {
    return this._poolSize - this._pool.length;
  }
  // Optionally passed a dirty ship that is **not** considered part of the current pool
  _updatePool(dirtyShip) {
    // Desired size is the number of running/queued items + the number of in progress items
    const desiredSize = Math.min(this._inProgress() + this._queue.length + this._minSpareShips, this._maxShips);
    if (dirtyShip) {
      // if our pool is big enough, discard the dirty ship
      if (desiredSize <= this._poolSize) {
        dirtyShip.dispose();
      } else { // if our pool is too small, re-use the dirty ship
        this._pool.push(dirtyShip.reset());
        this._poolSize++;
      }
    }
    while (this._poolSize > desiredSize) {
      // take the least ready ship (i.e. most recently used)
      this._pool.pop().dispose();
      this._poolSize--;
    }
    while (this._poolSize < desiredSize) {
      this._pool.push(this._buildShip());
      this._poolSize++;
    }
    while (this._queue.length && this._pool.length) {
      const job = this._queue.shift();
      // take the least recently used ship because it's most likely to already be on and cleaned up
      const ship = this._pool.shift();
      job(ship);
    }
  }


  run(...args) {
    return new Promise((resolve, reject) => {
      this._queue.push(ship => {
        return ship.run(...args).then(
          result => {
            this._poolSize--;
            this._updatePool(ship);
            return result;
          },
          err => {
            // If anything went wrong, we destroy the droplet just in case the droplet is somehow in a bad state
            this._poolSize--;
            ship.dispose();
            this._updatePool();
            throw err;
          },
        ).done(resolve, reject);
      });
      // The pool may need to increase in size, or may be big enough to immediately start executing
      this._updatePool();
    });
  }
}
export default class DigitalNavyWrapper {
  constructor({token, keypair, name, prepare, behaviour, workerSize, builderSize, maxShips, minSpareShips}) {
    const client = new DigitalOcean(token, keypair);
    this._navy = buildSnapshot(client, {name, size: builderSize || workerSize || '512mb', prepare}).then(image => {
      return new DigitalNavy(
        () => new DigitalShip(client, {name, size: workerSize || '512mb', image, behaviour}),
        {maxShips, minSpareShips},
      );
    });
    this.ready = this._navy.then(navy => navy.ready);
  }
  run(...args) {
    return this._navy.then(navy => navy.run(...args));
  }
}
