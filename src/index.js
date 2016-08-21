import DigitalNavy from './digital-navy';

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

module.exports = DigitalNavy;
DigitalNavy.installNode = installNode;
