"use strict";

const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const request = require('request');
const cheerio = require('cheerio');
const crypto = require('crypto');

var defaults = {
    
  htmlLinks: {
    "a": ["href"],
    "link": ["href"],
    "script": ["src"],
    "img": ["src", "data-original"],
    "meta[property='og:image']": ["content"]
    
  },
  
  additionalTargets: [
    "/robots.txt",
    "/sitemap.xml"
  ],
  
  // keep these as remote
  remoteMatch: /\b(?:maxcdn\.|cdnjs\.|code\.jquery|fonts\.googleapis)\b/,
  
  // Whether or not to console.log a lot
  verbose: false,
  
  // Try to get 304 Not Modified, using date, etag
  try304: true,
    
  // how many concurrent requests
  parallel: 2,
  
  // User-agent
  userAgent: "konnektor.host/1.0 +https://www.hostkonnektor.de/",
  
  completed: function() {
    //console.log("completed");
  },
  
  error: function(msg) {
    console.error("ERROR: "+msg);
  },
  
  log: function(msg) {
    function shorten(s) {
      if (s.length <= 50)
              return s;
      var t = [], w = s.split(/\s+/);
      for (let i in w) {
        if (w[i].length > 75) {
          t.push(w[i].replace(/^(.{42}).{10,}(.{8})$/, "$1...$2"));
        }
        else {
          t.push(w[i]);
        }
      }
      return t.join(" ");
    }
    
    console.log(shorten(msg));
  }
  
};


/**
 * A tree to keep the structure of update files.
 * In web context, a tree node can be both, a file and a directory 
 * (in contrast to a unix file tree);
 * e.g.: "/foo" has content, while "/foo/bar" also.
 * 
 * A data node is a tuple (file,dir), where
 * - file can be null or must otherwise point to a different file name;
 * - dir is considered as a dictionary, where any key is of the form
 *   "/name" and points to a data node.
 * 
 */
function DB(tree) {
  tree || (tree = [null]);
  this.tree = tree;
}

DB.prototype.getNode = function(path) {
  var q = path.substring(1, path.length).split("/"), n = this.tree;
  for (let i in q) {
    var k = "/"+q[i];
    if (n.length == 2 && n[1].hasOwnProperty(k)) {
      n = n[1][k];
    }
    else {
      return null;
    }
  }
  return n[0];
};

DB.prototype.setNode = function(path,data) {
  var q = path.substring(1, path.length).split("/"), n = this.tree;
  for (let i in q) {
    var k = "/"+q[i];
    if (n.length < 2) {
      n.push({});
    }
    if (!n[1].hasOwnProperty(k)) {
      n[1][k] = [null];
    }
    n = n[1][k];
  }
  n[0] = data;
};

  
/**
 * Client class to manage an entire update session.
 */  
function Client(config) {
  this.config = config;
  // assert: config.url.endsWith("/")
  // base: [ "scheme://host/path", "scheme://host", "/path" ]
  this.base = config.url.match(/^(https?:\/\/[^\/]+)((?:\/.*)?\/)$/).slice(0);
  this.queue = [ this.base[2] ]; // first target
  this.enqueued = {};
  this.enqueued[this.base[2]] = true;
  for (let i in config.additionalTargets) 
    this.enqueue(config.additionalTargets[i]);
}

Client.prototype.enqueue = function(path) {
  if (!this.enqueued.hasOwnProperty(path)) { // only once
    this.enqueued[path] = true;
    this.queue.push(path);
    return true;
  }
  return false;
};

Client.prototype.dequeue = function() {
  if (this.queue.length)
    return this.queue.shift();
  return null;
};

Client.prototype.remoteResource = function(current,link) {    
  // assert: current.startsWith(this.base[2])
  var i, q = "";
  
  // remove anchor
  if (0 <= (i = link.indexOf("#"))) { 
    link = link.substr(0,i);
  }

  // remember query
  if (0 <= (i = link.indexOf("?"))) {
    q = link.substr(i);
    link = link.substr(0,i);
  }
  
  // full url (this host) given
  if (link.startsWith(this.base[0])) {
    return path.normalize(link.substr(this.base[1].length, link.length))+q;
  }
  
  // other host or some "scheme://..." or "//..."
  if (link.match(/^(?:[a-z]+\:|\/\/)/i)) {
    
    
    return null;
    
//     // ignore certain remote locations
//     if (link.match(this.config.remoteMatch)) {
//       return null;
//     }
//     if (link.startsWith("//"))
//       return "https:"+link;
//     return link; // as it is
  }
  
  // absolute path below base path
  if (link.startsWith(this.base[2])) {
    return path.normalize(link)+q;
  }
  
  // relative path given
  // # path.dirname("/foo/bar/") === "/foo/"
  // # path.resolve doesn't add a trailing '/'
  // # empty href maps to itself
  var n;
  if (link.length) {
    var d = current.endsWith("/") ? current : current.replace(/[^\/]+$/,"");
    n = d + path.normalize(link);
  }
  else {
    n = current;
  }
  
  if (link.match(/\.\/?$/) && !n.endsWith("/")) {
    n += "/";
  }
  if (n.startsWith(this.base[2])) { // below base path
    return n+q;
  }
  return null; // ignore parent
};


Client.prototype.localPath = function(resource) {
  var local = this.config.localPath, respath = resource, m;
  if (m = resource.match(/^(https?:\/\/[^\/]+)(\/.*)$/)) { 
    // remote resource
    var h = crypto.createHash('md5').update(m[1]).digest('hex');
    respath = "/"+ h + m[2];
  }
  var u = decodeURIComponent(respath.replace(/\+/g, '%20')),
    m = u.match(/^([^\?]+)(?:\?(.*))?$/),
    p = path.join(local, m[1]), q = m[2];
  return this.config.filename(p, q);
};


/**
 * Scan HTML for links
 */
Client.prototype.scanHTML = function(requestPath, buffer, output) {
  // $ = jQuery-like thing (cheerio)
  var $ = cheerio.load(buffer, {
    normalizeWhitespace: true
  }), handle = this.config.htmlLinks;
  for (let e in handle) {
    if (handle.hasOwnProperty(e)) {
      var atlist = handle[e];
      $(e).each((function(i,o) {
        var $o = $(o);
        for (let i in atlist) {
          var lp, href;
          if (href = $o.attr(atlist[i])) {
            if (null != (lp = this.remoteResource(requestPath, href))) {
              
              if (this.enqueue(lp)) {
                if (this.config.verbose) this.config.log("scanHTML: href: "+lp);
              }
              
            }
            
            if (href.match(this.config.remoteMatch)) {
              // update attribute value
              $o.attr(atlist[i], href.replace(/^https?:\/\//, "//"));
            }
            
            
          }
        }
      }).bind(this));
    }
  }
  
  output($.html());
};

/**
 * Scan CSS for links
 */
Client.prototype.scanCSS = function(requestPath, buffer, output) {
  var re = /\burl\s*\(([^\)]+)/g, m;
  while (m = re.exec(buffer)) {
    var u = m[1].startsWith("'") || m[1].startsWith('"') ? 
      m[1].substring(1,m[1].length-1) : m[1], sp;
      
      
    if (null != (sp = this.remoteResource(requestPath, u))) {
        if (this.enqueue(sp)) {
          if (this.config.verbose) this.config.log("scanCSS: url: "+sp);
        }
    }
  }
  
  output(buffer);
};

/**
 * Get scanner function(buffer, output)
 */
Client.prototype.scanner = function(requestPath, mimetype) {
  var p = {
    html: Client.prototype.scanHTML.bind(this, requestPath),
    css: Client.prototype.scanCSS.bind(this, requestPath)
  };
  
  var r;
  if (r = mimetype.match(/^text\/(html|css)/)) {
    return p[r[1]];
  }
  /*else if (mimetype.match(/\bjavascript\b/)) {
    return "javascript";
  }*/
  return null;
};

Client.prototype.get = function(resource, dbNode, result, error) {

  var options = {
    url: resource.startsWith("/") ? this.base[1]+resource : resource,
    headers: {
      "user-agent": this.config.userAgent
    },
    encoding: null, // body will be of type Buffer
    gzip: true
  }, 
  localPath = this.localPath(resource),
  version = 0;
  
  function writeFile(done, error, buffer) {
    mkdirp(path.dirname(localPath), (function (err) {
      if (err) {
        return error(err);
      } 
      fs.writeFile(localPath, buffer, (function(err) {
        if(err) {
          return error(err);
        }
        if (this.config.verbose) this.config.log("saved: "+localPath);
        done();
      }).bind(this)); 
    }).bind(this));
  }
  
  function doRequest(result, error) {
    
    // HTTP request
    if (this.config.verbose) this.config.log("fetch: "+options.url);
    request(options, (function(requesterror, response, body) {
      // error
      if (requesterror) {
        return error("Request Error: "+options.url+": "+requesterror);
      }

      this.config.log(options.url+" -> "+response.statusCode);
      
//       // result
//       var res = { 
//           status: response.statusCode, 
//           length: body.length, // Buffer
//           local: localPath.substring(this.config.localPath.length+1),
//           version: ++version
//         },
        
      // >>>>>>>>>
        
      var res, now = (new Date).toISOString();
      if (dbNode != null) {
        // copy old node values, increment version, updated
        res = JSON.parse(JSON.stringify(dbNode));
        res.version = dbNode.version + 1;
        res.updated = now;
      }
      else {
        res = {
          version: 1,
          created: now,
          errors: 0
        };
      }
      res.local = localPath.substring(this.config.localPath.length+1);
              
      // copy certain response headers
      res.status = response.statusCode;
      (function(h) {
        for (var i in h)
          if (response.headers.hasOwnProperty(h[i]))
            res[h[i]] = response.headers[h[i]];
      })(["date", "content-type", "content-length", "cache-control", "etag"]);

      
      // <<<<<<<

      
      switch (response.statusCode) {
        
        case 200: // OK
          // process + save
          res.fileversion = dbNode != null ? (dbNode.fileversion || 0) + 1 : 1;
          res.fileupdated = now;
          res.length = body.length; // byte length, match content-length
          res.errors = 0;
          var save = writeFile.bind(this, result.bind(this,res), error), scan,
            ct = (response.headers["content-type"] || "").replace(/;.+$/,"");
          if (null != (scan = this.scanner(resource, ct))) {
            scan.call(this, body, save);
          }
          else {
            save.call(this, body);
          }
          break;
          
        case 304: // Not Modified
          result(res);
          break;
        
        case 404: // non-Fatal errors
        case 401:
        case 500:
          res.errors = dbNode != null ? (dbNode.errors || 0) + 1 : 1;
          result(res);
          break;
          
        default: // unexpected
          return error(response.statusCode);
      }

    }).bind(this));
    
  }
  
  // update node, options
  var run; // (result, error)
    
  if (dbNode != null) {
    if (dbNode.hasOwnProperty("version"))
      version = dbNode.version;
  }

  if (dbNode != null && this.config.try304) {
    run = (function(result, error) { // try 304 only if file exists
      fs.exists(localPath, (exists) => {
        if (exists) {
          options.headers["if-modified-since"] = dbNode["date"];
          if (dbNode.hasOwnProperty("etag")) {
            options.headers["if-none-match"] = dbNode["etag"];
          }
        }
        doRequest.call(this, result, error);
      });
    }).bind(this);
  }
  else {
    run = doRequest.bind(this);
  }
  run.call(this, result, error);
}


/**
 * main
 */
module.exports = function(config) {

  function readJson(path, result, error) {
    fs.exists(path, (exists) => {
      if (config.verbose) config.log(exists ? 'exists: '+path : 'does not exist: '+path);
      if (exists) {
        fs.readFile(path, {encoding: 'utf-8'}, function(err,data){
            if (!err) {
              result(JSON.parse(data));
            } else {
              error(err);
            }
        });
      }
      else {
        result([null]);
      }
    });    
    
  }
  
  function writeJson(path, data, done) {
    fs.writeFile(path, JSON.stringify(data,null,2), done);
  }

  // main
  if (!config.url.endsWith("/"))
    config.url += "/";
  for (var k in defaults) {
    if (!config.hasOwnProperty(k)) {
      config[k] = defaults[k];
    }
  }

  // config.url ends with '/'
  //var client = new Client(config.url);
  readJson(config.jsonPath, (function(client, dbdata) {
    var oldDB = new DB(dbdata), newDB = new DB();
    
    // actual request
    function pr(p) {
      return new Promise((resolve,reject) => {
        client.get(p, oldDB.getNode(p), function(result) {
          newDB.setNode(p, result);
          resolve(result);
        }, function(error) { reject(error); });
      });
    }
    
    // bulk request promise
    function prom() {
      return new Promise( (resolve,reject) => {
        var prms = [], p;
        for (var i = 1; i <= config.parallel; i++) {
          if (null != (p = client.dequeue())) {
            prms.push(pr(p));
          }
        }
        Promise.all(prms).then((results) => {
          //console.dir(results);
          return results.length ? prom() : null;
        }).then(function() {
          resolve();
        })
        .catch((err) => reject(err));
      });
    }
    
    prom().then(function() {
      writeJson(config.jsonPath, newDB.tree, function(err) {
        if (err) {
          return config.error("Failed to create "+config.jsonPath+": "+err);
        }
        config.log("created: "+config.jsonPath);
        config.completed();
      });
    }).catch((err) => config.error(err));
    
  }).bind(null, new Client(config)));

};



