# AcFun 4K120 全能解锁 (播放器内播放 + 直链下载)

一个用于解锁 AcFun 网页端 App 独占 4K120 帧画质，并提供视频直链提取与下载命令一键复制的 Tampermonkey 用户脚本。

## 功能特性

1. **播放器内解锁 4K120**
   - 绕过网页端 ksPlayJson 接口限制，将网页端播放器清晰度选项恢复为完整的 App 阶梯级菜单。
   - 网页端直接渲染播放 4K120画质（需登录并拥有相关清晰度权限），支持强制 H.264 解码。
2. **多清晰度直链提取**
   - 自动获取该视频下所有清晰度的 m3u8 播放直链，自动将 http 协议转换为 https 协议以防网络劫持。
3. **一键生成下载命令**
   - 一键复制适用于 `ffmpeg` 或 `N_m3u8DL-RE` 的完整视频下载命令，省去手动拼接参数的烦恼。

## 安装方式

1. 确保您的浏览器已安装 [Tampermonkey](https://www.tampermonkey.net/)（油猴插件）或其它兼容的脚本管理器。
2. 访问 [Greasy Fork](https://greasyfork.org/)，搜索 “AcFun 4K120 全能解锁” 进行安装。
3. 或者直接在脚本管理器中添加 [acfun_4k120_all.user.js](https://raw.githubusercontent.com/epstomai/acfun-4k120/main/acfun_4k120_all.user.js) 链接进行安装。

## 许可证

本项目基于 MIT 许可证开源。
