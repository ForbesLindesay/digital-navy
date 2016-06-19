const fs = require('fs');

try {
  fs.readFileSync(__dirname + '/run-artifact');
  throw new Error('Environment not properly cleaned up');
} catch (ex) {
  if (ex.code !== 'ENOENT') throw ex;
  fs.writeFileSync(__dirname + '/run-artifact', 'this script should always be run in a fresh build');
}

console.log('Hello World');
