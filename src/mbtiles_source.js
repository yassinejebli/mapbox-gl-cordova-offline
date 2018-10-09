import VectorTileSource from 'mapbox-gl/src/source/vector_tile_source'
import pako from 'pako/lib/inflate'
import base64js from 'base64-js'
const SQL = require('sql.js');

class MBTilesSource extends VectorTileSource {

    constructor(id, options, dispatcher, eventedParent) {
        super(id, options, dispatcher, eventedParent);
        this.type = "mbtiles";
        this.db = this.openDatabase(options.path);
    }

    openDatabase(dbLocation) {
        const dbName = dbLocation.split("/").slice(-1)[0]; // Get the DB file basename
        const source = this;
        if ('sqlitePlugin' in self) {
            if('device' in self) {
                return new Promise(function (resolve, reject) {
                    if(device.platform === 'Android') {
                        resolveLocalFileSystemURL(cordova.file.applicationStorageDirectory, function (dir) {
                            dir.getDirectory('databases', {create: true}, function (subdir) {
                                resolve(subdir);
                            });
                        }, reject);
                    } else if(device.platform === 'iOS') {
                        resolveLocalFileSystemURL(cordova.file.documentsDirectory, resolve, reject);
                    } else {
                        reject("Platform not supported");
                    }
                }).then(function (targetDir) {
                    return new Promise(function (resolve, reject) {
                        targetDir.getFile(dbName, {}, resolve, reject);
                    }).catch(function () {
                        return source.copyDatabaseFile(dbLocation, dbName, targetDir)
                    });
                }).then(function () {
                    var params = {name: dbName};
                    if(device.platform === 'iOS') {
                        params.iosDatabaseLocation = 'Documents';
                    } else {
                        params.location = 'default';
                    }
                    return sqlitePlugin.openDatabase(params);
                });
            } else {
                return Promise.reject(new Error("cordova-plugin-device not available. " +
                    "Please install the plugin and make sure this code is run after onDeviceReady event"));
            }
        } else {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', dbLocation, true);
            xhr.responseType = 'arraybuffer';return new Promise(function (resolve, reject) {
                xhr.onload = function (e) {
                    var uInt8Array = new Uint8Array(this.response);
                    resolve(new SQL.Database(uInt8Array));
                };
                xhr.send();
            });
        }
    }

    copyDatabaseFile(dbLocation, dbName, targetDir) {
        console.log("Copying database to application storage directory");
        return new Promise(function (resolve, reject) {
            const absPath =  cordova.file.applicationDirectory + 'www/' + dbLocation;
            resolveLocalFileSystemURL(absPath, resolve, reject);
        }).then(function (sourceFile) {
            return new Promise(function (resolve, reject) {
                sourceFile.copyTo(targetDir, dbName, resolve, reject);
            }).then(function () {
                console.log("Database copied");
            });
        });
    }

    readTile(z, x, y, callback) {
        const params = [z, x, y];
        if ('sqlitePlugin' in self && 'device' in self) { // if the app is running on mobile
            const query = 'SELECT BASE64(tile_data) AS base64_tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?';
            this.db.then(function(db) {
                db.transaction(function (txn) {
                    txn.executeSql(query, params, function (tx, res) {
                        if (res.rows.length) {
                            const base64Data = res.rows.item(0).base64_tile_data;
                            const rawData = pako.inflate(base64js.toByteArray(base64Data));
                            callback(undefined, base64js.fromByteArray(rawData));
                        } else {
                            callback(new Error('tile ' + params.join(',') + ' not found'));
                        }
                    });
                }, function (error) {
                    callback(error);
                });
            }).catch(function(err) {
                callback(err);
            });
        }else{ // if the app is running on browser
            this.db.then(function(db){
                const results = db.exec('SELECT tile_data FROM tiles where zoom_level=' + z + ' AND tile_column=' + x + ' AND tile_row=' + y);
                if(results.length){
                    const rawData = pako.inflate(results[0].values[0][0]);
                    callback(undefined, base64js.fromByteArray(rawData));
                }else{
                    callback(new Error('tile ' + params.join(',') + ' not found'));
                }
            }).catch(function(error){
                callback(error);
            });
        }

    }

    loadTile(tile, callback) {
        const coord = tile.tileID.canonical;
        const overscaling = coord.z > this.maxzoom ? Math.pow(2, coord.z - this.maxzoom) : 1;

        const z = Math.min(coord.z, this.maxzoom || coord.z); // Don't try to get data over maxzoom
        const x = coord.x;
        const y = Math.pow(2,z)-coord.y-1; // Tiles on database are tms (inverted y axis)

        this.readTile(z, x, y, dispatch.bind(this));

        function dispatch(err, base64Data) {
            if (err) {
                return callback(err);
            }
            if (base64Data == undefined) {
              return callback(new Error("empty data"));
            }

            const params = {
                request: { url: "data:application/x-protobuf;base64," + base64Data },
                uid: tile.uid,
                tileID: tile.tileID,
                zoom: coord.z,
                tileSize: this.tileSize * overscaling,
                type: this.type,
                source: this.id,
                pixelRatio: window.devicePixelRatio || 1,
                overscaling: overscaling,
                showCollisionBoxes: this.map.showCollisionBoxes
            };

            if (!tile.workerID || tile.state === 'expired') {
                tile.workerID = this.dispatcher.send('loadTile', params, done.bind(this));
            } else if (tile.state === 'loading') {
                // schedule tile reloading after it has been loaded
                tile.reloadCallback = callback;
            } else {
                this.dispatcher.send('reloadTile', params, done.bind(this), tile.workerID);
            }

            function done(err, data) {
                if (tile.aborted)
                    return;

                if (err) {
                    return callback(err);
                }

                if (this.map._refreshExpiredTiles) tile.setExpiryData(data);
                tile.loadVectorData(data, this.map.painter);

                callback(null);

                if (tile.reloadCallback) {
                    this.loadTile(tile, tile.reloadCallback);
                    tile.reloadCallback = null;
                }
            }
        }
    }
}

export default MBTilesSource;
