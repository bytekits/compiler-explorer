// Copyright (c) 2012-2017, Matt Godbolt
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

const temp = require('temp'),
    fs = require('fs'),
    path = require('path'),
    httpProxy = require('http-proxy'),
    denodeify = require('denodeify'),
    quote = require('shell-quote'),
    _ = require('underscore-node'),
    logger = require('../logger').logger,
    utils = require('../utils'),
    CompilationEnvironment = require('../compilation-env').CompilationEnvironment,
    Raven = require('raven');

temp.track();

let oneTimeInit = false;

function initialise(ceProps, compilerEnv) {
    if (oneTimeInit) return;
    oneTimeInit = true;
    const tempDirCleanupSecs = ceProps("tempDirCleanupSecs", 600);
    logger.info("Cleaning temp dirs every " + tempDirCleanupSecs + " secs");
    setInterval(() => {
        if (compilerEnv.isBusy()) {
            logger.warn("Skipping temporary file clean up as compiler environment is busy");
            return;
        }
        temp.cleanup((err, stats) => {
            if (err) logger.error("Error cleaning directories: ", err);
            if (stats) logger.debug("Directory cleanup stats:", stats);
        });
    }, tempDirCleanupSecs * 1000);
}

class CompileHandler {
    constructor(ceProps, compilerPropsL) {
        this.compilersById = {};
        this.compilerEnv = new CompilationEnvironment(ceProps, compilerPropsL);
        this.factories = {};
        this.stat = denodeify(fs.stat);
        this.textBanner = compilerPropsL('textBanner');
        this.proxy = httpProxy.createProxyServer({});
        initialise(ceProps, this.compilerEnv);
    }

    create(compiler) {
        const type = compiler.compilerType || "default";
        if (this.factories[type] === undefined) {
            const compilerPath = '../compilers/' + type;
            logger.info("Loading compiler from", compilerPath);
            this.factories[type] = require(compilerPath);
        }
        if (path.isAbsolute(compiler.exe)) {
            // Try stat'ing the compiler to cache its mtime and only re-run it if it
            // has changed since the last time.
            return this.stat(compiler.exe)
                .then(res => {
                    const cached = this.findCompiler(compiler.lang, compiler.id);
                    if (cached && cached.mtime.getTime() === res.mtime.getTime()) {
                        logger.debug(compiler.id + " is unchanged");
                        return cached;
                    }
                    return this.factories[type](compiler, this.compilerEnv, compiler.lang) // TODO why pass compiler.lang?
                        .then(compiler => {
                            if (compiler) compiler.mtime = res.mtime;
                            return compiler;
                        });
                })
                .catch(err => {
                    logger.warn("Unable to stat compiler binary", err);
                    return null;
                });
        } else {
            return this.factories[type](compiler, this.compilerEnv, compiler.lang); // TODO, why pass compiler.lang?
        }
    }

    setCompilers(compilers) {
        // Delete every compiler first...
        this.compilersById = {};
        return Promise.all(_.map(compilers, this.create, this))
            .then(_.compact)
            .then(compilers => {
                _.each(compilers, compiler => {
                    const langId = compiler.compiler.lang;
                    if (!this.compilersById[langId]) this.compilersById[langId] = {};
                    this.compilersById[langId][compiler.compiler.id] = compiler;
                });
                return _.map(compilers, compiler => compiler.getInfo());
            })
            .catch(err => logger.error(err));
    }

    findCompiler(langId, compilerId) {
        if (langId && this.compilersById[langId]) {
            return this.compilersById[langId][compilerId];
        }
        // If the lang is bad, try to find it in every language
        let response;
        _.each(this.compilersById, compilerInLang => {
            if (response === undefined) {
                _.each(compilerInLang, compiler => {
                    if (response === undefined && compiler.compiler.id === compilerId) {
                        response = compiler;
                    }
                });
            }
        });
        return response;
    }

    compilerFor(req) {
        const lang = req.lang || req.body.lang;
        if (req.is('json')) {
            return this.findCompiler(lang, req.params.compiler || req.body.compiler);
        } else {
            return this.findCompiler(lang, req.params.compiler);
        }
    }

    parseRequest(req, compiler) {
        let source, options, backendOptions, filters;
        // IF YOU MODIFY ANYTHING HERE PLEASE UPDATE THE DOCUMENTATION!
        if (req.is('json')) {
            // JSON-style request
            const requestOptions = req.body.options;
            source = req.body.source;
            options = requestOptions.userArguments;
            backendOptions = requestOptions.compilerOptions;
            filters = requestOptions.filters || compiler.getDefaultFilters();
        } else {
            // API-style
            source = req.body;
            options = req.query.options;
            // By default we get the default filters.
            filters = compiler.getDefaultFilters();
            // If specified exactly, we'll take that with ?filters=a,b,c
            if (req.query.filters) {
                filters = _.object(_.map(req.query.filters.split(","), filter => [filter, true]));
            }
            // Add a filter. ?addFilters=binary
            _.each((req.query.addFilters || "").split(","), filter => {
                if (filter) filters[filter] = true;
            });
            // Remove a filter. ?removeFilter=intel
            _.each((req.query.removeFilters || "").split(","), filter => {
                if (filter) delete filters[filter];
            });
        }
        options = _.chain(quote.parse(options || '')
            .map(x => typeof(x) === "string" ? x : x.pattern))
            .compact()
            .value();
        return {source, options, backendOptions, filters};
    }

    handle(req, res, next) {
        const compiler = this.compilerFor(req);
        if (!compiler) return next();
        const {source, options, backendOptions, filters} = this.parseRequest(req, compiler);
        const remote = compiler.getRemote();
        if (remote) {
            req.url = req.originalUrl;  // Undo any routing that was done to get here (i.e. /api/* path has been removed)
            this.proxy.web(req, res, {target: remote}, e => {
                logger.error("Proxy error: ", e);
                next(e);
            });
            return;
        }

        if (source === undefined) {
            return next(new Error("Bad request"));
        }

        function textify(array) {
            return _.pluck(array || [], 'text').join("\n");
        }

        compiler.compile(source, options, backendOptions, filters)
            .then(
                result => {
                    if (req.accepts(['text', 'json']) === 'json') {
                        res.set('Content-Type', 'application/json');
                        res.end(JSON.stringify(result));
                    } else {
                        res.set('Content-Type', 'text/plain');
                        try {
                            if (!_.isEmpty(this.textBanner)) res.write('# ' + this.textBanner + "\n");
                            res.write(textify(result.asm));
                            if (result.code !== 0) res.write("\n# Compiler exited with result code " + result.code);
                            if (!_.isEmpty(result.stdout)) res.write("\nStandard out:\n" + textify(result.stdout));
                            if (!_.isEmpty(result.stderr)) res.write("\nStandard error:\n" + textify(result.stderr));
                        } catch (ex) {
                            Raven.captureException(ex, {req: req});
                            res.write("Error handling request: " + ex);
                        }
                        res.end('\n');
                    }
                },
                error => {
                    logger.error("Error during compilation", error);
                    if (typeof(error) !== "string") {
                        if (error.code) {
                            if (typeof(error.stderr) === "string") {
                                error.stdout = utils.parseOutput(error.stdout);
                                error.stderr = utils.parseOutput(error.stderr);
                            }
                            res.end(JSON.stringify(error));
                            return;
                        }
                        error = "Internal Compiler Explorer error: " + (error.stack || error);
                    }
                    res.end(JSON.stringify({code: -1, stderr: [{text: error}]}));
                }
            );
    }
}

module.exports.Handler = CompileHandler;