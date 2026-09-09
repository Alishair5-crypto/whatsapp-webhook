'use strict';

// Isolated catalogue image-management endpoint.
// This file does not import or modify the active Zara webhook.

const handler = require('../catalogue/image-handler');

module.exports = handler;
