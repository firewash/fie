
'use strict';

const request = require('axios');
const { env } = require('fie-api');
const fieModule = require('fie-module');
const fieCache = require('fie-cache');
const fieConfig = require('fie-config');
const { exec, execSync, spawn, spawnSync } = require('child_process');
const vm = require('vm');

const co = require('co');
const log = require('fie-log')('fie-rule-dispatcher');

// 先从环境变量里获取fie配置文件的目录，这样方便做调试
const cwd = process.cwd();
const ruleDataCacheKey = 'dynamic-rules';
const ruleDataCacheExpire = 3600000; // 1小时
const publisherUrl = 'http://app-494.shuttle.alibaba.net/openapi/config/fie/4'; // 'http://127.0.0.1:6001/openapi/config/fie/online';// 'http://fiecfg.alibaba-inc.com/api/config/fie/online';

// fie.config.js中的插件配置
// forceUpdateRules: 强制更新数据
// disableDynamicRules: 允许用户关闭动态规则执行

const {
  forceUpdateRules,
  disableDynamicRules // 用于用
} = fieConfig.get('rule-dispatcher') || {};
let fieAllRules = {};

async function fetchRulesOnline() {
  let data = null;
  try {
    const resp = await request(publisherUrl);
    const body = resp.data;
    const _data = body.data;
    data = _data.constructor.name === 'Array' ? _data[0] : _data; // {code,data}
  } catch (e) {
    log.error('FIE配置数据接口无法访问:', e);
  }
  return data;
}

function saveRuleDataToCache(data) {
  fieCache.set(ruleDataCacheKey, data, { expires: ruleDataCacheExpire });
  log.debug('saveRuleDataToCache', data);
  return true;
}

function readRuleDataFromCache() {
  const cache = fieCache.get(ruleDataCacheKey);
  log.debug('readRuleDataFromCache: ', cache);
  return cache;
}

/** 同步线上规则到本地 */
async function syncRules() {
  log.debug('syncRules');
  if (!env.isIntranet()) return []; // 外网环境无需同步规则
  let data = readRuleDataFromCache();
  if (!data || forceUpdateRules) {
    try {
      data = await fetchRulesOnline();
      saveRuleDataToCache(data);
    } catch (e) {
      log.error('fie同步规则出错', e);
    }
  }
  fieAllRules = data ? data.value : {};

  return fieAllRules;
}


function getRules({ toolkit, command, preriod }) {
  const toolkitConfig = fieAllRules[toolkit] || {};
  const commandConfig = toolkitConfig[command] || {};
  const rules = commandConfig[preriod];
  return rules;
}

async function installPluginsIfNeed(plugin) {
// 按需安装fie 插件
  const module = await (new Promise((resolve) => {
    co(function* () {
      const mod = yield fieModule.get(plugin);
      resolve(mod);
    });
  }));
  return module;
}

// 执行一段sh命令
async function execShell({ script, async = true, silent = true }) {
  log.debug(`execShell: ${script}`, `. async=${async}, silent=${silent}`);  // silent暂不实现.
  const words = script.split(' ');
  const [command, ...args] = words;
  let process = null;
  if (async) {  // 异步
    return new Promise((resolve, reject) => {
      log.debug(`execShell异步执行:  ${script}`);
      process = spawn(command, args, { encoding: 'utf8', stdio: 'inherit' });

      process.stdout && process.stdout.on('data', (data) => { // process.stdout is null when spawn option have : stdio: 'inherit'
        const msg = String(data);
        log.info(`execShell 成功, ${script}`);
        log.debug(msg);
      });

      process.stderr && process.stderr.on('data', (data) => {
        const msg = String(data);
        log.error(`execShell 失败, ${script}`);
        log.debug(msg);
      });

      process.on('exit', (code) => {
        log.debug('rule dispatcher exit:', code);
        resolve(code);
      });
    });
  }
  // 同步
  const result = {
    success: true,
    message: ''
  };

  try {
    log.debug('run script in child process:');
    process = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' }); // {silent,}
    result.message = process.stdout;
    log.debug('execShell同步执行成功', process);
  } catch (e) {
    result.success = false;
    result.message = e;
    log.debug('execShell同步执行出错', e);
  }

  return result;
}

function execJS({ script, async = false, silent = true, plugin }) {
  const vmscript = new vm.Script(script);
  const sandbox = {
    curFiePlugin: plugin
  };
  const result = vmscript.runInNewContext(sandbox);
  log.debug(`execJS: script =${script} ,result = ${result}`);
  return result;
}

/** * 执行一个套件的指定规则 */
async function execRules({ toolkit, command, preriod }) {
  if (disableDynamicRules) {
    return null;
  }
  log.debug(`execRules: toolkit=${toolkit}, command=${command}, preriod=${preriod} `);
  const rules = getRules({ toolkit, command, preriod });
  log.debug(`and rules = : ${rules}`);
  if (!rules) return null;
  const promises = rules.map(async (rule) => {
    const { plugin, script, async, type = 'shell', silent } = rule;
    let fiePlugin;
    if (plugin) {
      fiePlugin = await installPluginsIfNeed(plugin);
      log.debug('plugin existed or installed:', fiePlugin);
    }
    switch (type) {
      case 'node': {
        return execJS({ script, async, silent, plugin: fiePlugin });
      }
      case 'shell':
      default: {
        return await execShell({ script, async, silent });
      }
    }
  });
  const result = await Promise.all(promises);
  return result;
}

/** 初始化 规则管理插件 */
async function init() {
  log.debug('fie-rule-dispatcher init');
  return await syncRules();
}

const dispatcher = {
  init,
  syncRules,
  execRules
};


module.exports = dispatcher;
