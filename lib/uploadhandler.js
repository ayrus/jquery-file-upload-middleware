var EventEmitter = require('events').EventEmitter,
    path = require('path'),
    fs = require('fs'),
    formidable = require('formidable'),
    imageMagick = require('imagemagick'),
    mkdirp = require('mkdirp'),
    _ = require('lodash');

var upload_directory = null;
var FileInfo = null;
var username = null;

function get_upload_directory(){
    return upload_directory;
}

function validatePath(relativePath, fileName){

    relativePath = unescape(relativePath);
    fileName = unescape(fileName);

    var fullPath = relativePath + fileName;
    //Check for .. in relative path
    var pathReg1 = /.*\.\..*/;
    //Check that the fileName doesn't contain / or \
    var pathReg2 = /(.*(\/|\\).*)/;
    //Further validation on the name mostly ensures characters are alphanumeric 
    var pathReg3 = /^([a-zA-Z0-9_ .]|-)*$/;

    return !(pathReg1.exec(relativePath)
          || pathReg2.exec(fileName)
          || !pathReg3.exec(fileName)
          || pathReg1.exec(fullPath));
}

module.exports = function (options) {

    var UploadHandler = function (req, res, callback) {
        EventEmitter.call(this);
        this.req = req;
        this.res = res;
        this.callback = callback;
        username = req.session.user_id;
    };
    require('util').inherits(UploadHandler, EventEmitter);

    UploadHandler.prototype.noCache = function () {
        this.res.set({
            'Pragma': 'no-cache',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Content-Disposition': 'inline; filename="files.json"'
        });
    };

    UploadHandler.prototype.get = function () {
    };

    UploadHandler.prototype.post = function () {

        var self = this,
            form = new formidable.IncomingForm(),
            tmpFiles = [],
            files = [],
            map = {},
            counter = 1,
            redirect,
            finish = _.bind(function () {
                if (!--counter) {
                    _.each(files, function (fileInfo) {
                        this.initUrls(fileInfo);
                        this.emit('end', fileInfo);
                    }, this);
                    this.callback(files, redirect);
                }
            }, this);

        this.noCache();

        form.uploadDir = options.tmpDir;
        form
            .on('fileBegin', function (name, file) {
                console.log("Begin file... ");
                tmpFiles.push(file.path);
                var fileInfo = new FileInfo(file);
                fileInfo.safeName();
                map[path.basename(file.path)] = fileInfo;
                files.push(fileInfo);
                self.emit('begin', fileInfo);
            })
            .on('field', function (name, value) {

                if(!validatePath(value, "")){
                    return;
                }
                md5h = require('MD5'),
                app_dir = require('../../../config').app_dir;
                upload_directory = app_dir + '/users/' + md5h(username) + value;

                FileInfo = require('./fileinfo')(
                    _.extend({
                        baseDir: function() { return get_upload_directory(); }
                    }, _.pick(options, 'minFileSize', 'maxFileSize', 'acceptFileTypes'))
                );

                if (name === 'redirect') {
                    redirect = value;
                }
            })
            .on('file', function (name, file) {
                var fileInfo = map[path.basename(file.path)];
                if (fs.existsSync(file.path)) {
                    fileInfo.size = file.size;
                    if (!fileInfo.validate()) {
                        fs.unlink(file.path);
                        return;
                    }

                    var generatePreviews = function () {
                        if (options.imageTypes.test(fileInfo.name)) {
                            _.each(options.imageVersions, function (value, version) {
                                // creating directory recursive
                                if (!fs.existsSync(get_upload_directory() + '/' + version + '/'))
                                    mkdirp.sync(get_upload_directory() + '/' + version + '/');

                                counter++;
                                var opts = options.imageVersions[version];
                                imageMagick.resize({
                                    width: opts.width,
                                    height: opts.height,
                                    srcPath: get_upload_directory() + '/' + fileInfo.name,
                                    dstPath: get_upload_directory() + '/' + version + '/' + fileInfo.name,
                                    customArgs: opts.imageArgs || ['-auto-orient']
                                }, finish);
                            });
                        }
                    }

                    if (!fs.existsSync(get_upload_directory() + '/'))
                        mkdirp.sync(get_upload_directory() + '/');

                    counter++;
                    fs.rename(file.path, get_upload_directory() + '/' + fileInfo.name, function (err) {
                        if (!err) {
                            generatePreviews();
                            finish();
                        } else {
                            var is = fs.createReadStream(file.path);
                            var os = fs.createWriteStream(get_upload_directory() + '/' + fileInfo.name);
                            is.on('end', function (err) {
                                if (!err) {
                                    fs.unlinkSync(file.path);
                                    generatePreviews();
                                }
                                finish();
                            });
                            is.pipe(os);
                        }
                    });
                }
            })
            .on('aborted', function () {
                _.each(tmpFiles, function (file) {
                    var fileInfo = map[path.basename(file)];
                    self.emit('abort', fileInfo);
                    fs.unlink(file);
                });
            })
            .on('error', function (e) {
                self.emit('error', e);
            })
            .on('progress', function (bytesReceived, bytesExpected) {
                if (bytesReceived > options.maxPostSize)
                    self.req.connection.destroy();
            })
            .on('end', finish)
            .parse(self.req);
    };

    UploadHandler.prototype.destroy = function () {
    };

    UploadHandler.prototype.initUrls = function (fileInfo) {
        var baseUrl = (options.ssl ? 'https:' : 'http:') + '//' + (options.hostname || this.req.get('Host'));
        fileInfo.setUrl(null, baseUrl + options.uploadUrl());
        fileInfo.setUrl('delete', baseUrl + this.req.originalUrl);
        _.each(options.imageVersions, function (value, version) {
            if (fs.existsSync(options.uploadDir() + '/' + version + '/' + fileInfo.name)) {
                fileInfo.setUrl(version, baseUrl + options.uploadUrl() + '/' + version);
            }
        }, this);
    };

    return UploadHandler;
}

