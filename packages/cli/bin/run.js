#!/usr/bin/env node

async function main() {
  const { execute } = require('@oclif/core');
  await execute({ dir: __dirname });
}

main();
