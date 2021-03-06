var fs = require('fs');
var url = require('url');
var pem = require('pem');
var https = require('https');
var join = require('path').join;
var cheerio = require('cheerio');
var request = require('request');
var thunkify = require('thunkify');

// CRX packaging module, instantiated with the `new` keyword
var Extension = require('crx');

// POST /generate
module.exports = function *() {
    // Get target URL from input
    var url = this.request.body.url;
    
    // Build .crx config for the provided URL
    var crxConfig = yield exports.buildCrxConfig(url);
    
    // Generate the .crx file based on the config
    var crxBuffer = yield exports.generateCrx(crxConfig);
    
    // Send it to the browser (save to disk)
    yield exports.sendCrx(this, crxConfig, crxBuffer);
}

exports.buildCrxConfig = function *(targetUrl) {
    // Prepare crx object
    var crxConfig = {};
    
    // Get target URL from params
    crxConfig.url = targetUrl;

    // Bad input?
    if (! crxConfig.url) {
        throw new Error('Please provide a URL to continue.');
    }
    
    // Parse URL (to retrieve hostname and verify its validity)
    crxConfig.parsedUrl = url.parse(crxConfig.url);
    
    // Parse failed?
    if (! crxConfig.parsedUrl || ! crxConfig.parsedUrl.protocol || crxConfig.parsedUrl.protocol.indexOf('http') == -1) {
        throw new Error('Please provide a valid URL for your extension. (It must start with http(s)://)');
    }

    // Prepare request (send fake browser header)
    var req = {
        url: crxConfig.url,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36'
        }
    };
    
    // Execute GET request to provided URL
    var response = yield thunkify(request)(req);
    
    // Load DOM into Cheerio (HTML parser)
    var dom = cheerio.load(response[0].body);
    
    // Extract extension title from the dom's <title> tag
    crxConfig.title = dom('title').text().trim() || crxConfig.parsedUrl.hostname;
    
    // Create a friendly .crx filename based on the given hostname
    crxConfig.filename = crxConfig.parsedUrl.hostname + '.crx';
    
    // Extract .crx icon from page's shortcut-icon <link> element
    crxConfig.icon = dom('link[rel="icon"], link[rel="shortcut icon"]').attr('href');
     
    // Custom icons per host (workaround for no <link> tag)
    switch(crxConfig.parsedUrl.host) {
        case 'web.whatsapp.com':
            crxConfig.icon = 'https://web.whatsapp.com/favicon-64x64.ico';
            break;
        case 'keep.google.com':
            crxConfig.icon = 'https://ssl.gstatic.com/keep/icon_128.png';
            break;
        case 'messenger.com':
            // Fix weird 0x8234 chars in FB messenger <title> 
            crxConfig.title = 'Messenger'
            crxConfig.icon = 'https://lh5.ggpht.com/0VYAvZLR9YhosF-thqm8xl8EWsCfrEY_uk2og2f59K8IOx5TfPsXjFVwxaHVnUbuEjc=w300';
            break;
    }
    
    // Return crx config
    return crxConfig;
}

exports.generateCrx = function* (crxConfig) {
    // Generate pem certificate
    var cert = yield thunkify(pem.createCertificate)({days:365 * 10, selfSigned:true});
    
    // Init new .crx extension with our private key
    var crx = new Extension({privateKey: cert.clientKey});

    // Load extension manifest and default icon
    yield crx.load(join(__dirname, "../lib/extension/files"));
    
    // Set extension title to extension URL's <title>
    crx.manifest.name = crxConfig.title;
    
    // Ask for permission to access the specified URL
    crx.manifest.app.urls.push(crxConfig.url);
    
    // Configure the launch behavior of the extension to the specfied URL
    crx.manifest.app.launch.web_url = crxConfig.url;
    
    // Got a favicon?
    if (crxConfig.icon) {
        // Download it and overwrite default icon
        yield exports.downloadIcon(crxConfig, crx);
    }

    // Pack the extension into a .crx and return its buffer
    var crxBuffer = yield crx.pack();
    
    // Return buffer
    return crxBuffer;
}

exports.downloadIcon = function*(crxConfig, crx) {
    // Convert relative icon path to absolute
    var absoluteIconUrl = url.resolve(crxConfig.url, crxConfig.icon);
   
    // Resolve succeeded?
    if (absoluteIconUrl) {
        // Set download path as current extension icon's path
        var downloadPath = crx.path + "/" + crx.manifest.icons['128'];
        
        // Download it
        yield exports.downloadFile(absoluteIconUrl, downloadPath);
    }
}

exports.sendCrx = function*(request, crxConfig, crxBuffer) {
    // Set content-type to .crx extension mime type
    request.set('content-type', 'application/x-chrome-extension');
    
    // Set extension filename
    request.set('content-disposition', 'attachment; filename=' + crxConfig.filename);

    // Set the request body to the .crx file buffer
    request.body = crxBuffer;
}

exports.downloadFile = function(url, filepath) {
    // Promisify the request
    return new Promise(function(resolve, reject) {
        try {
            // Create write stream
            var stream = fs.createWriteStream(filepath);
            
            // Wait for finish event
            stream.on('finish', function() {
                // Resolve the promise
                return resolve(true);
            });
            
            // Return the piped request
            return request(url).pipe(stream);
        } catch (e) {
            // Failed
            return reject(e);
        }
    });
};