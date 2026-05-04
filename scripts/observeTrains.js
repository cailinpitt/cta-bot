#!/usr/bin/env node
// Densifies train-observations capture by polling Train Tracker every 2 min.
// recordTrainObservations is invoked by getAllTrainPositions; this script's
// only job is to call it on its own cadence so detection cron jobs aren't the
// only writers to the observations table.

require('../src/shared/env');

const { setup, runBin } = require('../src/shared/runBin');
const { getAllTrainPositions } = require('../src/train/api');

async function main() {
  setup();
  try {
    const trains = await getAllTrainPositions();
    console.log(`observe-trains: recorded ${trains.length} trains`);
  } catch (e) {
    console.warn(`observe-trains: getAllTrainPositions failed: ${e.message}`);
  }
}

runBin(main);
