const fs = require('fs');
module.exports.readFile = function (path) {
	return new Promise((res, rej) => {
		fs.readFile(path, (err, data) => {
			if (err) {
				rej(err);
			} else {
				res(data);
			}
		})
	})

}
