// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2016 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const Tp = require('thingpedia');
const TpDiscovery = require('thingpedia-discovery');
const ThingTalk = require('thingtalk');

const Config = require('../config');

const db = require('./db');
const device = require('../model/device');
const organization = require('../model/organization');
const schemaModel = require('../model/schema');
const exampleModel = require('../model/example');
const entityModel = require('../model/entity');
const stringModel = require('../model/strings');

const DatasetUtils = require('./dataset');
const SchemaUtils = require('./manifest_to_schema');
const FactoryUtils = require('./device_factories');
const I18n = require('./i18n');
const codeStorage = require('./code_storage');
const { NotFoundError, ForbiddenError, BadRequestError } = require('./errors');
const resolveLocation = require('./location-linking');

class ThingpediaDiscoveryDatabase {
    getByDiscoveryService(discoveryType, service) {
        return db.withClient((dbClient) => device.getByDiscoveryService(dbClient, discoveryType, service));
    }
    getAllDiscoveryServices(deviceId) {
        return db.withClient((dbClient) => device.getAllDiscoveryServices(dbClient, deviceId));
    }

    // for compatibility until thingpedia-discovery is updated
    getByAnyKind(kind) {
        if (kind.startsWith('bluetooth-'))
            return this.getByDiscoveryService('bluetooth', kind.substring('bluetooth-'.length));
        if (kind.startsWith('upnp-'))
            return this.getByDiscoveryService('upnp', kind.substring('upnp-'.length));
        return db.withClient((dbClient) => device.getByAnyKind(dbClient, kind));
    }
    getAllKinds(deviceId) {
        return this.getAllDiscoveryServices(deviceId).then((services) => services.map((s) => {
            return { kind: s.discovery_type + s.service };
        }));
    }

    getByPrimaryKind(kind) {
        return db.withClient((dbClient) => device.getByPrimaryKind(dbClient, kind));
    }
}

var _discoveryServer = new TpDiscovery.Server(new ThingpediaDiscoveryDatabase());

const CATEGORIES = new Set(['media', 'social-network', 'home', 'communication', 'health', 'service', 'data-management']);

module.exports = class ThingpediaClientCloud extends Tp.BaseClient {
    constructor(developerKey, locale, dbClient = null) {
        super();

        this._developerKey = developerKey;
        this._locale = locale;
        this.language = I18n.localeToLanguage(locale);

        this._dbClient = null;
    }

    get developerKey() {
        return this._developerKey;
    }

    get locale() {
        return this._locale;
    }

    _withClient(func) {
        if (this._dbClient)
            return func(this._dbClient);
        else
            return db.withClient(func);
    }

    async _getOrg(dbClient) {
        const [org] = await organization.getByDeveloperKey(dbClient, this.developerKey);
        return org || null;
    }
    async _getOrgId(dbClient) {
        const org = await this._getOrg(dbClient);
        if (org === null)
            return null;
        else if (org.is_admin)
            return -1;
        else
            return org.id;
    }

    async getModuleLocation(kind, version) {
        const [approvedVersion, maxVersion] = await this._withClient(async (dbClient) => {
            const org = await this._getOrg(dbClient);
            const dev = await device.getDownloadVersion(dbClient, kind, org);
            if (!dev.downloadable)
                throw new BadRequestError('No Code Available');
            return [dev.approved_version, dev.version];
        });
        if (maxVersion === null || version > maxVersion)
            throw new ForbiddenError('Not Authorized');
        if (version === undefined || version === '')
            version = maxVersion;

        const developer = approvedVersion === null || version > approvedVersion;

        return codeStorage.getDownloadLocation(kind, version, developer);
    }

    getDeviceCode(kind, accept) {
        return this._withClient(async (dbClient) => {
            const orgId = await this._getOrgId(dbClient);
            const devs = await device.getFullCodeByPrimaryKind(dbClient, kind, orgId);
            if (devs.length < 1)
                throw new NotFoundError();

            const dev = devs[0];
            const isJSON = /^\s*\{/.test(dev.code);

            let manifest;
            if (isJSON) {
                manifest = JSON.parse(dev.code);
                manifest.version = dev.version;
            }

            let code;
            if (isJSON)
                code = ThingTalk.Ast.fromManifest(kind, manifest).prettyprint();
            else
                code = dev.code;

            // fast path without parsing the code
            if (this.language === 'en' && accept === 'application/x-thingtalk')
                return code;

            const parsed = ThingTalk.Grammar.parse(code);
            const classDef = parsed.classes[0];

            if (this.language !== 'en') {
                const schema = await schemaModel.getMetasByKinds(dbClient, [kind], orgId, this.language);
                SchemaUtils.mergeClassDefAndSchema(classDef, schema[0]);
            }

            switch (accept) {
            case 'application/json':
                if (!isJSON)
                    manifest = ThingTalk.Ast.toManifest(parsed);
                if (dev.version !== dev.approved_version)
                    manifest.developer = true;
                else
                    manifest.developer = false;
                return manifest;
            case 'application/x-thingtalk':
            default:
                return parsed.prettyprint();
            }
        });
    }

    getSchemas(schemas, withMetadata, accept = 'application/x-thingtalk') {
        if (schemas.length === 0)
            return Promise.resolve({});

        return this._withClient(async (dbClient) => {
            let rows;
            if (withMetadata)
                rows = await schemaModel.getMetasByKinds(dbClient, schemas, await this._getOrgId(dbClient), this.language);
            else
                rows = await schemaModel.getTypesAndNamesByKinds(dbClient, schemas, await this._getOrgId(dbClient));

            switch (accept) {
            case 'application/json': {
                const obj = {};
                rows.forEach((row) => {
                    obj[row.kind] = {
                        kind_type: row.kind_type,
                        triggers: row.triggers,
                        actions: row.actions,
                        queries: row.queries
                    };
                });
                return obj;
            }

            case 'application/x-thingtalk':
            default: {
                const classDefs = SchemaUtils.schemaListToClassDefs(rows, withMetadata);
                return classDefs.prettyprint();
            }
            }
        });
    }

    getDeviceSearch(q) {
        return this._withClient(async (dbClient) => {
            const org = await this._getOrg(dbClient);
            return device.getByFuzzySearch(dbClient, q, org);
        });
    }

    getDeviceList(klass, page, page_size) {
        return this._withClient(async (dbClient) => {
            const org = await this._getOrg(dbClient);
            if (klass) {
                if (['online','physical','data','system'].indexOf(klass) >= 0)
                    return device.getByCategory(dbClient, klass, org, page*page_size, page_size+1);
                else if (CATEGORIES.has(klass))
                    return device.getBySubcategory(dbClient, klass, org, page*page_size, page_size+1);
                else
                    throw new BadRequestError("Invalid class parameter");
            } else {
                return device.getAllApproved(dbClient, org, page*page_size, page_size+1);
            }
        });
    }

    _ensureDeviceFactory(device) {
        if (device.factory !== null)
            return typeof device.factory === 'string' ? JSON.parse(device.factory) : device.factory;

        assert(/\s*\{/.test(device.code));
        const classDef = ThingTalk.Ast.ClassDef.fromManifest(device.primary_kind, JSON.parse(device.code));
        return FactoryUtils.makeDeviceFactory(classDef, device);
    }

    getDeviceFactories(klass) {
        return this._withClient(async (dbClient) => {
            const org = await this._getOrg(dbClient);

            let devices;
            if (klass) {
                if (['online','physical','data','system'].indexOf(klass) >= 0)
                    devices = await device.getByCategoryWithCode(dbClient, klass, org);
                else if (CATEGORIES.has(klass))
                    devices = await device.getBySubcategoryWithCode(dbClient, klass, org);
                else
                    throw new BadRequestError("Invalid class parameter");
            } else {
                devices = await device.getAllApprovedWithCode(dbClient, org);
            }

            const factories = [];
            for (let d of devices) {
                const factory = this._ensureDeviceFactory(d);
                if (factory)
                    factories.push(factory);
            }
            return factories;
        });
    }

    getDeviceSetup(kinds) {
        if (kinds.length === 0)
            return Promise.resolve({});

        return this._withClient(async (dbClient) => {
            const org = await this._getOrg(dbClient);

            for (let i = 0; i < kinds.length; i++) {
                 if (kinds[i] === 'messaging')
                     kinds[i] = Config.MESSAGING_DEVICE;
            }

            const devices = await device.getDevicesForSetup(dbClient, kinds, org);
            const result = {};
            devices.forEach((d) => {
                try {
                    d.factory = this._ensureDeviceFactory(d);
                    if (d.factory) {
                        if (d.for_kind in result) {
                            if (result[d.for_kind].type !== 'multiple') {
                                 let first_choice = result[d.for_kind];
                                 result[d.for_kind] = { type: 'multiple', choices: [first_choice] };
                            }
                            result[d.for_kind].choices.push(d.factory);
                        } else {
                            result[d.for_kind] = d.factory;
                        }
                        if (d.for_kind === Config.MESSAGING_DEVICE)
                            result['messaging'] = d.factory;
                    }
                } catch(e) { /**/ }
            });

            for (let kind of kinds) {
                if (!(kind in result))
                    result[kind] = { type: 'multiple', choices: [] };
            }

            return result;
        });
    }

    // FIXME: remove this when almond-dialog-agent is fixed to use getDeviceSetup
    getDeviceSetup2(kinds) {
        return this.getDeviceSetup(kinds);
    }

    getKindByDiscovery(body) {
        return Promise.resolve().then(() => _discoveryServer.decode(body));
    }

    _datasetBackwardCompat(rows, applyCompat = false) {
        for (let row of rows) {
            if (/^[ \r\n\t\v]*(stream|query|action)[ \r\n\t\v]*(:=|\()/.test(row.target_code)) {
                // backward compatibility: convert to a declaration
                const dummydataset = `dataset @foo { ${row.target_code} }`;
                const parsed = ThingTalk.Grammar.parse(dummydataset);
                const example = parsed.datasets[0].examples[0];
                const declaration = new ThingTalk.Ast.Program([],
                    [new ThingTalk.Ast.Statement.Declaration('x',
                        example.type, example.args, example.value)],
                    [], null);
                row.target_code = declaration.prettyprint(true);
            } else {
                row.target_code = row.target_code.replace(/^[ \r\n\t\v]*program[ \r\n\t\v]*:=/, '').replace(/\};\s*$/, '}');
            }
            if (applyCompat) {
                row.target_code = row.target_code.replace(/^[ \r\n\t\v]*let[ \r\n\t\v]+query[ \r\n\t\v]/, 'let table ');

                row.target_code = row.target_code.replace(/^[ \r\n\t\v]*let[ \r\n\t\v]+(table|action|stream)[ \r\n\t\v]+x[ \r\n\t\v]*(\(.+\))[ \r\n\t\v]+:=[ \r\n\t\v]+/,
                    'let $1 x := \\$2 -> ');
            }
            delete row.name;
        }
        return rows;
    }
    _makeDataset(name, rows) {
        return DatasetUtils.examplesToDataset(`org.thingpedia.dynamic.${name}`, this.language, rows);
    }

    getExamplesByKey(key, accept = 'application/x-thingtalk') {
        return this._withClient(async (dbClient) => {
            const rows = await exampleModel.getByKey(dbClient, key, await this._getOrgId(dbClient), this.language);
            switch (accept) {
            case 'application/json;apiVersion=1':
                return this._datasetBackwardCompat(rows, true);
            case 'application/json':
                return this._datasetBackwardCompat(rows, false);
            default:
                return this._makeDataset(`by_key.${key.replace(/[^a-zA-Z0-9]+/g, '_')}`,
                    rows);
            }
        });
    }

    getExamplesByKinds(kinds, accept = 'application/x-thingtalk') {
        if (!Array.isArray(kinds))
            kinds = [kinds];
        if (kinds.length === 0)
            return Promise.resolve([]);
        return this._withClient(async (dbClient) => {
            const rows = await exampleModel.getByKinds(dbClient, kinds, await this._getOrgId(dbClient), this.language);
            switch (accept) {
            case 'application/json;apiVersion=1':
                return this._datasetBackwardCompat(rows, true);
            case 'application/json':
                return this._datasetBackwardCompat(rows, false);
            default:
                return this._makeDataset(`by_kinds.${kinds.map((k) => k.replace(/[^a-zA-Z0-9]+/g, '_')).join('__')}`,
                    rows);
            }
        });
    }

    clickExample(exampleId) {
        return this._withClient((dbClient) => {
            return exampleModel.click(dbClient, exampleId);
        });
    }

    lookupEntity(entityType, searchTerm) {
        return this._withClient((dbClient) => {
            return Promise.all([entityModel.lookupWithType(dbClient, this.language, entityType, searchTerm),
                                entityModel.get(dbClient, entityType, this.language)]);
        }).then(([rows, metarows]) => {
            const data = rows.map((r) => ({ type: r.entity_id, value: r.entity_value, canonical: r.entity_canonical, name: r.entity_name }));
            const meta = { name: metarows.name, has_ner_support: metarows.has_ner_support, is_well_known: metarows.is_well_known };
            return { data, meta };
        });
    }

    lookupLocation(searchTerm) {
        return resolveLocation(this.locale, searchTerm);
    }

    getAllExamples(accept = 'application/x-thingtalk') {
        return this._withClient(async (dbClient) => {
            const rows = await exampleModel.getBaseByLanguage(dbClient, await this._getOrgId(dbClient), this.language);
            switch (accept) {
            case 'application/json':
                return this._datasetBackwardCompat(rows, false);
            default:
                return this._makeDataset(`everything`, rows);
            }
        });
    }

    getAllDeviceNames() {
        return this._withClient(async (dbClient) => {
            return schemaModel.getAllApproved(dbClient, await this._getOrgId(dbClient));
        });
    }

    async getThingpediaSnapshot(getMeta, snapshotId = -1) {
        return this._withClient(async (dbClient) => {
            if (snapshotId >= 0) {
                if (getMeta)
                    return schemaModel.getSnapshotMeta(dbClient, snapshotId, this.language, await this._getOrgId(dbClient));
                else
                    return schemaModel.getSnapshotTypes(dbClient, snapshotId, await this._getOrgId(dbClient));
            } else {
                if (getMeta)
                    return schemaModel.getCurrentSnapshotMeta(dbClient, this.language, await this._getOrgId(dbClient));
                else
                    return schemaModel.getCurrentSnapshotTypes(dbClient, await this._getOrgId(dbClient));
            }
        });
    }

    getAllEntityTypes(snapshotId = -1) {
        return this._withClient((dbClient) => {
            if (snapshotId >= 0)
                return entityModel.getSnapshot(dbClient, snapshotId);
            else
                return entityModel.getAll(dbClient);
        }).then((rows) => {
            return rows.map((r) => ({
                type: r.id,
                name: r.name,
                is_well_known: r.is_well_known,
                has_ner_support: r.has_ner_support
            }));
        });
    }

    getAllStrings() {
        return this._withClient((dbClient) => {
            return stringModel.getAll(dbClient, this.language);
        }).then((rows) => {
            return rows.map((r) => ({
                type: r.type_name,
                name: r.name,
                license: r.license,
                attribution: r.attribution
            }));
        });
    }
};
module.exports.prototype.$rpcMethods = ['getAppCode', 'getApps',
                                        'getModuleLocation', 'getDeviceCode',
                                        'getSchemas', 'getMixins',
                                        'getDeviceSetup',
                                        'getDeviceSetup2',
                                        'getDeviceFactories',
                                        'getDeviceList',
                                        'getDeviceSearch',
                                        'getKindByDiscovery',
                                        'getExamplesByKinds', 'getExamplesByKey',
                                        'clickExample', 'lookupEntity', 'lookupLocation'];
