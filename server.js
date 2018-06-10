const fs = require('fs');
const fsp = require('./promise_stuff.js');
const express = require('express');
const http = require('http');
const MongoClient = require('mongodb').MongoClient;
const JSZip = require('jszip');
const request = require('request-promise-native');
const {
	validate
} = require('jsonschema');
const bodyParser = require('body-parser');
const {
	randomBytes
} = require('crypto');
const ejs = require('ejs');
const cookieParser = require('cookie-parser');
const validateMod = (m) => {
	const schema = {
		type: 'object',
		properties: {
			author: {
				type: 'string',
				required: true
			},
			build: {
				type: ['string', 'integer'],
				required: true
			},
			category: {
				type: 'array',
				items: {
					type: 'string'
				},
				required: true
			},
			context: {
				type: 'string',
				required: true,
				pattern: /server|client/
			},
			date: {
				type: 'string',
				required: true,
				pattern:/^\d{4}[\-\/\s]?((((0[13578])|(1[02]))[\-\/\s]?(([0-2][0-9])|(3[01])))|(((0[469])|(11))[\-\/\s]?(([0-2][0-9])|(30)))|(02[\-\/\s]?[0-2][0-9]))$/
			},
			description: {
				type: 'string',
				required: true
			},
			display_name: {
				type: 'string',
				required: true
			},
			//Requiring forum but does NOT have to be uber forums link
			forum: {
				type: 'string',
				required: true
			},
			identifier: {
				type: 'string',
				required: true
			},
			signature: {
				type: 'string',
				minLength: 1,
				required: true
			},
			authorised: {
				type: 'array',
				items: {
					type: 'string'
				}
			},
			icon: {
				type: 'string'
			},
			priority: {
				type: 'integer'
			},
			scenes: {
				type: 'object',
				properties: {
					".*": {
						type: 'array',
						items: {
							type: 'string'
						}
					}
				}
			},
			authors: {
				type: 'array',
				items: {
					type: 'string'
				}
			},
			titansOnly: {
				type: 'boolean'
			},
			website: {
				type: 'string'
			}
		}
	};
	const valid = validate(m, schema);
	return valid.errors.length ? JSON.stringify(valid.errors) : true;
};
const log = (r) => {
	console.log(`${new Date().toUTCString()} : ${r}`);
};
const COOKIE_PARAMS_USERV = {
	httpOnly: true,
	maxAge: 14 * 24 * 60 * 60 * 1000,
	secure: true, //Set to false for testing
	signed: true
};
module.exports = class PammServer {
	constructor(configFile) {
		let f = fs.readFileSync(configFile);
		f = JSON.parse(f);
		this.config = f;
		this.app = express();
		this.app.use('/public', express.static('public'));
		this.app.use(bodyParser.json());
		this.app.use(bodyParser.urlencoded({
			extended: true
		}));
		this.app.use(cookieParser(this.config.secretCookie));
		this.app.use((req, res, next) => {
			if (!req.signedCookies.userv) {
				res.clearCookie('userv', COOKIE_PARAMS_USERV);
				res.locals.gUser = false;
				res.locals.isAdmin = false;
				res.locals.isOwner = false;
				next();
				return;
			}
			let e = req.signedCookies.userv;
			e = e.split(':');
			if (Math.round(Date.now() / 1000) >= e[1]) {
				res.clearCookie('userv', COOKIE_PARAMS_USERV);
				res.locals.gUser = false;
				next();
				return;
			}
			res.locals.gUser = e[0];
			res.locals.isAdmin = this.admins.includes(res.locals.gUser.toLowerCase());
			res.locals.isOwner = res.locals.gUser === this.config.owner;
			next();
		});
		this.app.set('view engine', 'ejs');
		this.config.reverseProxy && this.app.enable('trust proxy');
		this.server = http.createServer(this.app);
		this.db = false;
		this.admins = [];
		this.bans = [];
	}
	userMiddleWare(red, c) {
		return (req, res, next) => {
			if (!res.locals.gUser) {
				res.redirect(c || 302, red || './');
				return;
			}
			if (this.bans.includes(res.locals.gUser.toLowerCase())) {
				res.render('error', {
					error: 'Due to your account privileges and GDPR laws, this webpage is no longer available to you.'
				});
				res.clearCookie('userv', COOKIE_PARAMS_USERV);
				return;
			}
			next();
		};
	}
	getZipData(uri) {
		return request({
			method: "GET",
			uri: uri,
			encoding: null
		});
	}
	async processZip(uri) {
		let data;
		try {
			data = await this.getZipData(uri)
		} catch (e) {
			throw 'failed to get file';
		};
		let zip = new JSZip();
		try {
			await zip.loadAsync(data);
		} catch (e) {
			throw 'not_zip';
		}
		//let's find modinfo
		let modinfo = false;
		for (let x of Object.keys(zip.files)) {
			if (x.split('/').includes('modinfo.json')) {
				modinfo = zip.file(x);
			}
		}
		if (!modinfo) {
			throw 'no_modinfo';
		}
		let q;
		try {
			q = await modinfo.async("string");
			q = JSON.parse(q);
			q.url = uri;
			q.priority = parseInt(q.priority) || 100;
			q.build = q.build.toString();
			q.author = q.authors ? q.authors.join(', ') : q.author;
		} catch (e) {
			throw 'bad_modinfo';
		}
		return q;
	}
	modExists(identifier) {
		return this.db.collection('mods').findOne({
			identifier: identifier
		});
	}
	addModToDb(mod) {
		return this.db.collection('mods').insertOne(mod);
	}
	updateModInDb(mod) {
		return this.db.collection('mods').replaceOne({
			identifier: mod.identifier
		}, mod);
	}
	async importFromFile(file) {
		const adminUsername = this.config.owner;
		try {
			let e = await fsp.readFile(file);
			e = JSON.parse(e);
			for (let x of e) {
				log(`Attempting to migrate ${x}`);
				try {
					let y = await this.processZip(x);
					y.forum = y.forum || 'http://forums.uberent.com/';
					y.date = y.date || '';
					y.signature = y.signature || 'not yet implemented';
					y.build = y.build || '0';
					y.category = y.category || [];
					let tested = validateMod(y);
					(tested === true) || log(tested);
					y.owner = adminUsername;
					y.enabled = true;
					await this.addModToDb(y);
				} catch (e) {
					log(`${x} FAILED ${e}`)
				}
			}
		} catch (f) {
			throw false;
		}
	}
	async processModRequest(uri, user) {
		let mod;
		try {
			mod = await this.processZip(uri);
		} catch (e) {
			throw e;
		}
		const exists = await this.modExists(mod.identifier);
		const valid = validateMod(mod);
		if (valid !== true) {
			log(`Mod failed tests. Error dump: ${valid}`);
			throw 'bad_modinfo';
		}
		if (exists) {
			if (user === exists.owner || this.admins.includes(user)) {
				mod.owner = exists.owner;
				mod.enabled = exists.enabled;
				this.updateModInDb(mod);
				log(`Updated mod ${mod.identifier} in DB (${exists.owner})`);
				return 'UPDATED MOD';
			} else {
				throw 'access_denied';
			}
		} else {
			mod.owner = user;
			mod.enabled = true;
			this.addModToDb(mod);
			log(`Added mod to DB from ${mod.owner} ${mod.identifier}`);
			return 'NEW MOD';
		}
	}
	//APIS!!!
	expressapis() {
		this.app.get('/api/mods', async (req, res) => {
			const mods = await this.db.collection('mods').find({
				enabled: true
			}).toArray();
			for (let x of mods) {
				delete x.owner;
				delete x.enabled;
				delete x._id;
			}
			res.json(mods);
		});
		this.app.get('/login', (req, res) => {
			res.clearCookie('userv', COOKIE_PARAMS_USERV);
			const cookieParams = {
				httpOnly: true,
				maxAge: 4 * 60 * 1000,
				secure: true,
				signed: true
			};
			const state = randomBytes(32).toString('hex');
			res.cookie('gitHubState', state, cookieParams);
			res.render('goElsewhere', {
				url: `https://github.com/login/oauth/authorize?client_id=${this.config.githubClientId}&scope=read:user&state=${state}`
			});
		});
		this.app.get('/logout', (req, res) => {
			res.clearCookie('userv', COOKIE_PARAMS_USERV);
			res.redirect('./');
		});
		this.app.get('/api/g_callback', async (req, res) => {
			const code = req.query.code;
			const state = req.query.state;
			const cookieState = req.signedCookies.gitHubState;
			if (!(code && state && cookieState && (cookieState === state))) {
				res.redirect('../');
				return;
			}
			let e = await request({
				uri: 'https://github.com/login/oauth/access_token',
				method: 'POST',
				form: {
					client_id: this.config.githubClientId,
					client_secret: this.config.githubClientSecret,
					code: code,
					state: state
				},
				headers: {
					Accept: 'application/json',
					'User-Agent': 'flubbateios'
				}
			});
			e = JSON.parse(e);
			const accessToken = e.access_token;
			const userinfo = await request({
				method: 'GET',
				uri: `https://api.github.com/user?access_token=${accessToken}`,
				headers: {
					Accept: 'application/json',
					'User-Agent': 'flubbateios'
				}
			});
			const username = JSON.parse(userinfo).login;
			if (this.bans.includes(username)) {
				res.redirect('../');
				return;
			}
			log(`${username} logged in.`)
			res.cookie('userv',
				`${username}:${COOKIE_PARAMS_USERV.maxAge/1000 + Math.round(Date.now()/1000)}`,
				COOKIE_PARAMS_USERV);
			res.redirect('../');
		});
		this.app.get('/', (req, res) => {
			res.render('index');
		});
		this.app.get('/mods', async (req, res) => {
			const mods = await this.db.collection('mods').find({
				enabled: true
			}).toArray();
			for (let x of mods) {
				delete x.owner;
				delete x.enabled;
				delete x._id;
			}
			mods.sort((a, b) => {
				return new Date(b.date).getTime() - new Date(a.date).getTime();
			});
			res.render('mods', {
				mods: mods,
				am: false
			})
		});
		this.app.get('/mods_admin', this.userMiddleWare('./'), async (req, res) => {
			const mods = await this.db.collection('mods').find().toArray();
			for (let x of mods) {
				delete x._id;
			}
			mods.sort((a, b) => {
				return new Date(b.date).getTime() - new Date(a.date).getTime();
			});
			res.render('mods', {
				mods: mods,
				am: true
			})
		});
		this.app.get('/addmod', this.userMiddleWare('./'), (req, res) => {
			res.render('addmod');
		});
		this.app.post('/addmod', this.userMiddleWare('./', 303), async (req, res) => {
			const user = res.locals.gUser;
			if (!req.body.uri) {
				res.redirect(303, "./");
				return;
			}
			let e;
			try {
				e = await this.processModRequest(req.body.uri, user);
			} catch (e) {
				res.render('error', {
					error: e
				});
			}
			if (e) {
				res.render('addmod', {
					message: e
				})
			}
		});
		this.app.get('/mymods', this.userMiddleWare('/'), async (req, res) => {
			const user = res.locals.gUser;
			const mods = await this.db.collection('mods').find({
				owner: user
			}).toArray();
			for (let x of mods) {
				delete x.owner;
				delete x._id;
			}
			mods.sort((a, b) => {
				return new Date(b.date).getTime() - new Date(a.date).getTime();
			});
			res.render('mymods', {
				mods: mods
			});
		});
		this.app.post('/setModStatus', this.userMiddleWare('/mods', 303), async (req, res) => {
			const user = res.locals.gUser;
			const isAdmin = res.locals.isAdmin;
			const id = req.body.identifier;
			const status = parseInt(req.body.status);
			if ((!id) || isNaN(status)) {
				res.render('error', {
					error: 'no-id-or-status'
				});
				return;
			}
			const mod = await this.modExists(id);
			if (!mod) {
				res.render('error', {
					error: 'no_mod'
				});
				return;
			}
			if (!(user === mod.owner || isAdmin)) {
				res.render('error', {
					error: 'access_denied'
				});
				return;
			}
			mod.enabled = !!status;
			log(`${user} ${status ? 'enabled':'disabled'} ${id}`);
			const a = await this.updateModInDb(mod);
			res.redirect('back');
		});
		this.app.post('/deleteMod', this.userMiddleWare('/mods', 303), async (req, res) => {
			const user = res.locals.gUser;
			const isAdmin = res.locals.isAdmin;
			const id = req.body.identifier;
			if (!id) {
				res.render('error', {
					error: 'no_id'
				});
				return;
			}
			if (!isAdmin) {
				res.render('error', {
					error: 'not_admin'
				});
				return;
			}
			log(`Admin ${user} deleted ${id}`);
			const a = (await this.db.collection('mods').deleteOne({
				identifier: id
			})).deletedCount;
			if (a === 0) {
				res.render('error', {
					error: 'no_mod'
				})
				return;
			}
			res.redirect('back');
		});
		this.app.post('/transferOwnership', this.userMiddleWare('/mods', 303), async (req, res) => {
			const user = res.locals.gUser;
			const isAdmin = res.locals.isAdmin;
			const id = req.body.identifier;
			const newUser = req.body.newUser;
			if (!(id && newUser)) {
				res.render('error', {
					error: 'no-id'
				});
				return;
			}
			if (!isAdmin) {
				res.render('error', {
					error: 'access_denied'
				});
				return;
			}
			log(`Admin ${user} transferred ownership of ${id} to ${newUser}`);
			const a = await this.db.collection('mods').updateOne({
				identifier: id
			}, {
				$set: {
					owner: newUser
				}
			}).modifiedCount;
			if (a === 0) {
				res.render('error', {
					error: 'no-mod'
				});
			}
			res.redirect('back');
		});
		this.app.get('/ban', this.userMiddleWare('/'), async (req, res) => {
			if (!res.locals.isAdmin) {
				res.render('error', {
					error: 'access_denied'
				});
				return;
			}
			res.render('ban', {
				bans: this.bans
			});
		});
		this.app.post('/ban', this.userMiddleWare('./', 303), async (req, res) => {
			if (!res.locals.isAdmin) {
				res.render('error', {
					error: 'access_denied'
				});
				return;
			}
			const action = req.body.act;
			const victim = req.body.victim.toLowerCase();
			if (!(action && victim)) {
				res.render('error', {
					error: 'no_victim_or_action'
				})
			}
			if (action === 'ban') {
				if (this.bans.includes(victim)) {
					res.render('error', {
						error: 'already_banned'
					});
					return;
				}
				log(`Admin ${res.locals.gUser} banned ${victim}`);
				this.bans.push(victim);
			} else if (action === 'unban') {
				const i = this.bans.indexOf(victim);
				if (i === -1) {
					res.render('error', {
						error: 'not_banned'
					});
					return;
				}
				log(`Admin ${res.locals.gUser} unbanned ${victim}`);
				this.bans.splice(i, 1);
			} else {
				res.render('error', {
					error: 'unknown_action'
				});
				return;
			}
			await this.synchronizeInfoWithDb('bans', this.bans);
			res.redirect(303, './ban');
		});
		this.app.get('/admins', this.userMiddleWare('/'), async (req, res) => {
			if (!res.locals.isOwner) {
				res.render('error', {
					error: 'access_denied'
				});
				return;
			}
			res.render('admins', {
				admins: this.admins
			});
		});
		this.app.post('/admins', this.userMiddleWare('./', 303), async (req, res) => {
			const action = req.body.act;
			const admin = req.body.admin.toLowerCase();
			if (!(action && admin)) {
				res.render('error', {
					error: 'no_admin_or_action'
				})
			}
			if (action === 'add') {
				if (this.admins.includes(admin)) {
					res.render('error', {
						error: 'already_admin'
					});
					return;
				}
				log(`Owner added ${admin} to admins.`);
				this.admins.push(admin);
			} else if (action === 'remove') {
				const i = this.admins.indexOf(admin);
				if (i === -1) {
					res.render('error', {
						error: 'not_admin'
					});
					return;
				}
				log(`Owner removed ${admin} from admins.`);
				this.admins.splice(i, 1);
			} else {
				res.render('error', {
					error: 'unknown_action'
				});
				return;
			}
			await this.synchronizeInfoWithDb('admins', this.admins);
			res.redirect(303, './admins');
		});
	}
	//INIT FUNCTIONS
	async initDb() {
		const url = this.config.dbAuth ?
			`mongodb://${encodeURIComponent(this.config.dbUser)}:${encodeURIComponent(this.config.dbPassword)}@${this.config.dbHost}:${this.config.dbPort}/${this.config.db}?authMechanism=DEFAULT&authSource=admin` :
			`mongodb://${this.config.dbHost}:${this.config.dbPort}/${this.db}`;
		let a;
		try {
			a = await MongoClient.connect(url);
		} catch (e) {
			log('Failed to connect to database. Exiting.');
		}
		this.db = a.db(this.config.db);
		log('Connected to database.');
		return true;
	}
	synchronizeInfoWithDb(key, content) {
		return this.db.collection('info').updateOne({
			tag: key
		}, {
			$set: {
				content: content
			}
		});
	}
	async init() {
		await this.initDb();
		let admins, bans;
		try {
			admins = (await this.db.collection('info').findOne({
				tag: 'admins'
			})).content;
			this.admins = admins;
		} catch {
			log('No admins in database. Creating list now and falling back to config admins.');
			this.db.collection('info').insertOne({
				tag: 'admins',
				content: this.config.admins
			});
			this.admins = this.config.admins;
		}
		try {
			bans = (await this.db.collection('info').findOne({
				tag: 'bans'
			})).content;
			this.bans = bans;
		} catch {
			log('No bans in database. Creating list now.');
			this.db.collection('info').insertOne({
				tag: 'bans',
				content: []
			});
		}
		this.expressapis();
		this.server.listen(this.config.port, this.config.host);
		log('Server is up.');
	}
};
