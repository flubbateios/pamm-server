const args = process.argv.slice(2);
const Server = require('./server.js');
const PammServer = new Server(args[0]);
PammServer.initDb().then(function(){
	return PammServer.importFromFile(args[1]);
}).then(function(){
	process.exit();
})