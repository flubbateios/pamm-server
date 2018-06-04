const args = process.argv.slice(2);
const Server = require('./server.js');
const PammServer = new Server(args[0]);
PammServer.init();