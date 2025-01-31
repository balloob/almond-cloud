// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2018 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const Url = require('url');
const path = require('path');
const util = require('util');
const fs = require('fs');
const Genie = require('genie-toolkit');

const AbstractFS = require('../../util/abstract_fs');
const sleep = require('../../util/sleep');
const Config = require('../../config');

module.exports = async function main(task, argv) {
    // on kubernetes, we might encounter a race when this pod is scheduled on a
    // newly started node, where the pod is started before the kube2iam daemonset
    // is ready
    // in turn, this means we don't have the right credentials to access s3, and die
    //
    // we work around that problem with an artificial 1 minute delay when training
    // we only do it for training, because other jobs are likely scheduled on existing
    // general-purpose nodes (where kube2iam is already active)
    // we also only do it for the kubernetes backend, because the local backend doesn't
    // have that problem, and we don't want our CI to become longer
    if (Config.TRAINING_TASK_BACKEND === 'kubernetes')
        await sleep(60000);

    const jobdir = await AbstractFS.download(task.jobDir + '/');
    const datadir = path.resolve(jobdir, 'dataset');
    const workdir = path.resolve(jobdir, 'workdir');
    const outputdir = path.resolve(jobdir, 'output');

    // create a dummy test.tsv file to placate decanlp
    await util.promisify(fs.writeFile)(path.resolve(datadir, 'test.tsv'), '');

    const genieConfig = {
        task_name: task.modelInfo.contextual ? 'contextual_almond' : 'almond',
        locale: task.language,
    };
    for (let key in task.config) {
        if (key.startsWith('dataset_'))
            continue;
        genieConfig[key] = task.config[key];
    }

    const options = {
        // do not pass the job ID to Genie, otherwise the lines will be prefixed twice
        backend: 'decanlp',
        locale: task.language,

        config: genieConfig,
        thingpediaUrl: Url.resolve(Config.SERVER_ORIGIN, Config.THINGPEDIA_URL),
        debug: true,

        workdir,
        datadir,
        outputdir
    };

    const genieJob = Genie.Training.createJob(options);
    genieJob.on('progress', async (value) => {
        task.setProgress(value);
        if (Config.TENSORBOARD_DIR) {
              await AbstractFS.sync(
                  workdir,
                  AbstractFS.resolve(Config.TENSORBOARD_DIR, task.jobId.toString(), `./${task.info.model_tag}:${task.language}/`),
                 '--exclude=*', '--include=*tfevents*');
        }
    });
    task.on('killed', () => {
        genieJob.kill();
    });

    await genieJob.train();

    if (!task.killed) {
        await AbstractFS.upload(outputdir, AbstractFS.resolve(task.jobDir, 'output'));
        await AbstractFS.removeTemporary(jobdir);
    }
};
