import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import rimraf from 'rimraf';
import Promise from 'promise';
import Response from 'http-response-object';
import {stringify, parse} from 'json-buffer';
import shasum from 'shasum';

const r = require;
const realRequest = r('then-request');

if (process.env.DIGITAL_OCEAN_KEY) {
  rimraf.sync(__dirname + '/recorded-requests');
  mkdirSync(__dirname + '/recorded-requests');
}

const requestCount = {};
export default function (method, url, options) {
  const args = [
    method,
    url.replace(/\d+/g, ''),
    {
      ...options,
      headers: {
        ...options.headers,
        authorization: 'NOT INCLUDED',
      },
    },
  ];
  const id = shasum(args);
  requestCount[id] = requestCount[id] || 0;
  const filename = __dirname + '/recorded-requests/' + id + '-' + (requestCount[id]++) + '.json';
  if (process.env.DIGITAL_OCEAN_KEY) {
    const result = realRequest(method, url, options);
    setTimeout(() => {
      result.done(res => {
        writeFileSync(filename, stringify(res));
      });
    }, 0);
    return result;
  } else {
    let cachedResult;
    try {
      cachedResult = parse(readFileSync(filename, 'utf8'));
    } catch (ex) {
      console.dir(args, {depth: 10, colors: true});
      throw ex;
    }
    const res = new Response(cachedResult.statusCode, cachedResult.headers, cachedResult.body);
    const resultPromise = Promise.resolve(res);
    resultPromise.getBody = (...args) => resultPromise.then(res => res.getBody(...args));
    return resultPromise;
  }
}
