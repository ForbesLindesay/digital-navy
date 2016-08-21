import Promise from 'promise';

export default function buildSnapshot(client, {name, size, prepare}) {
  let d = null;
  return client.getPaged(
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
    return client.createDroplet({
      name: 'dnavy-snapshot-creator-' + name,
      size,
      image: baseImage,
    }).then(droplet => {
      d = droplet;
      return client.connect(droplet).then(
        ssh => Promise.resolve(null).then(() => prepare(ssh)).finally(() => ssh.close())
      ).then(
        () => client.shutdownDroplet(droplet)
      ).then(
        () => client.snapshotDroplet(droplet, name)
      );
    }).finally(() => {
      if (d) return client.destroyDroplet(d);
    });
  });
}
