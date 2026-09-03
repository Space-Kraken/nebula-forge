#!/usr/bin/env node
'use strict';
require('../dist/server').startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
