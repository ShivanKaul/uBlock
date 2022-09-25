/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* jshint esversion:11 */

'use strict';

/******************************************************************************/

import {
    browser,
    dnr,
    runtime,
} from './ext.js';

import {
    CURRENT_CONFIG_BASE_RULE_ID,
    getRulesetDetails,
    getDynamicRules,
    defaultRulesetsFromLanguage,
    enableRulesets,
    getEnabledRulesetsStats,
    updateRegexRules,
} from './ruleset-manager.js';

import {
    getInjectableCount,
    registerInjectable,
} from './scripting-manager.js';

import {
    matchesTrustedSiteDirective,
    toggleTrustedSiteDirective,
} from './trusted-sites.js';

/******************************************************************************/

const rulesetConfig = {
    version: '',
    enabledRulesets: [],
};

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

async function loadRulesetConfig() {
    const dynamicRuleMap = await getDynamicRules();
    const configRule = dynamicRuleMap.get(CURRENT_CONFIG_BASE_RULE_ID);
    if ( configRule === undefined ) {
        rulesetConfig.enabledRulesets = await defaultRulesetsFromLanguage();
        return;
    }

    const match = /^\|\|example.invalid\/([^\/]+)\/(?:([^\/]+)\/)?/.exec(
        configRule.condition.urlFilter
    );
    if ( match === null ) { return; }

    rulesetConfig.version = match[1];
    if ( match[2] ) {
        rulesetConfig.enabledRulesets =
            decodeURIComponent(match[2] || '').split(' ');
    }
}

async function saveRulesetConfig() {
    const dynamicRuleMap = await getDynamicRules();
    let configRule = dynamicRuleMap.get(CURRENT_CONFIG_BASE_RULE_ID);
    if ( configRule === undefined ) {
        configRule = {
            id: CURRENT_CONFIG_BASE_RULE_ID,
            action: {
                type: 'allow',
            },
            condition: {
                urlFilter: '',
            },
        };
    }

    const version = rulesetConfig.version;
    const enabledRulesets = encodeURIComponent(rulesetConfig.enabledRulesets.join(' '));
    const urlFilter = `||example.invalid/${version}/${enabledRulesets}/`;
    if ( urlFilter === configRule.condition.urlFilter ) { return; }
    configRule.condition.urlFilter = urlFilter;

    return dnr.updateDynamicRules({
        addRules: [ configRule ],
        removeRuleIds: [ CURRENT_CONFIG_BASE_RULE_ID ],
    });
}

/******************************************************************************/

async function hasGreatPowers(origin) {
    return browser.permissions.contains({
        origins: [ `${origin}/*` ]
    });
}

function grantGreatPowers(hostname) {
    return browser.permissions.request({
        origins: [
            `*://${hostname}/*`,
        ]
    });
}

function revokeGreatPowers(hostname) {
    return browser.permissions.remove({
        origins: [
            `*://${hostname}/*`,
        ]
    });
}

/******************************************************************************/

function onMessage(request, sender, callback) {
    switch ( request.what ) {

    case 'applyRulesets': {
        enableRulesets(request.enabledRulesets).then(( ) => {
            rulesetConfig.enabledRulesets = request.enabledRulesets;
            return Promise.all([
                saveRulesetConfig(),
                registerInjectable(),
            ]);
        }).then(( ) => {
            callback();
        });
        return true;
    }

    case 'getRulesetData': {
        Promise.all([
            getRulesetDetails(),
            dnr.getEnabledRulesets(),
        ]).then(results => {
            const [ rulesetDetails, enabledRulesets ] = results;
            callback({
                enabledRulesets,
                rulesetDetails: Array.from(rulesetDetails.values()),
            });
        });
        return true;
    }

    case 'grantGreatPowers':
        grantGreatPowers(request.hostname).then(granted => {
            console.info(`Granted uBOL great powers on ${request.hostname}: ${granted}`);
            callback(granted);
        });
        return true;

    case 'popupPanelData': {
        Promise.all([
            matchesTrustedSiteDirective(request),
            hasGreatPowers(request.origin),
            getEnabledRulesetsStats(),
            getInjectableCount(request.origin),
        ]).then(results => {
            callback({
                isTrusted: results[0],
                hasGreatPowers: results[1],
                rulesetDetails: results[2],
                injectableCount: results[3],
            });
        });
        return true;
    }

    case 'revokeGreatPowers':
        revokeGreatPowers(request.hostname).then(removed => {
            console.info(`Revoked great powers from uBOL on ${request.hostname}: ${removed}`);
            callback(removed);
        });
        return true;

    case 'toggleTrustedSiteDirective': {
        toggleTrustedSiteDirective(request).then(response => {
            registerInjectable().then(( ) => {
                callback(response);
            });
        });
        return true;
    }

    default:
        break;

    }
}

async function onPermissionsChanged() {
    await registerInjectable();
}

/******************************************************************************/

async function start() {
    await loadRulesetConfig();
    await enableRulesets(rulesetConfig.enabledRulesets);

    // We need to update the regex rules only when ruleset version changes.
    const currentVersion = getCurrentVersion();
    if ( currentVersion !== rulesetConfig.version ) {
        console.log(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        updateRegexRules().then(( ) => {
            rulesetConfig.version = currentVersion;
            saveRulesetConfig();
        });
    }

    // Unsure whether the browser remembers correctly registered css/scripts
    // after we quit the browser. For now uBOL will check unconditionally at
    // launch time whether content css/scripts are properly registered.
    registerInjectable();

    const enabledRulesets = await dnr.getEnabledRulesets();
    console.log(`Enabled rulesets: ${enabledRulesets}`);

    dnr.getAvailableStaticRuleCount().then(count => {
        console.log(`Available static rule count: ${count}`);
    });

    dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
}

(async ( ) => {
    await start();

    runtime.onMessage.addListener(onMessage);

    browser.permissions.onAdded.addListener(onPermissionsChanged);
    browser.permissions.onRemoved.addListener(onPermissionsChanged);
})();
