// @name 播放记录拦截器（已废弃）
// @author OpenCode
// @description 已废弃：新版 OmniBox SDK 移除了 addPlayHistory，播放记录改由宿主根据 play() 返回值自动写入。本拦截器保留仅为兼容旧配置，运行时不做任何事，建议在拦截器管理里停用。
// @version 2.0.0
// @filter-stages play_after
// @filter-config-schema {"description":"已废弃，保留占位；启用也不会产生任何写入","fields":[]}

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

module.exports = { afterPlay };
runner.run(module.exports);

let warned = false;

async function afterPlay(params) {
  if (!warned) {
    warned = true;
    try {
      await OmniBox.log(
        "warn",
        "播放记录拦截器已废弃：SDK 已移除 addPlayHistory，播放记录由宿主自动记录；请在拦截器管理中停用本项"
      );
    } catch (_) {
      /* 日志失败不影响播放 */
    }
  }
  return (params && params.data) || {};
}
