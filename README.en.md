<p align="center"><img src="docs/brand/banner.jpg" alt="CicaTavern" width="720"></p>

<p align="center"><a href="README.md">简体中文</a> | English</p>

# CicaTavern

**An agent-style player for SillyTavern character cards.** Import the character cards, world books and presets you already use, and play them with **your own model API** (DeepSeek, OpenRouter, Anthropic, OpenAI, Gemini, a local Ollama and more).

- **High cache hit rates**: long stories stay cheap, and replies start fast.
- **Long-term memory**: what was compacted away comes back when the story brings it up.
- **SillyTavern-compatible**: cards, world books, presets, regex, MVU variables and status bars work as imported.
- **Pictures and read-aloud**: illustrate a scene with one click; dialogue and narration each get their own voice.
- **Visual novel and game rules**: the story becomes a game screen, with dice checks and turn-based fights.
- **A guided card creator**: it asks you step by step and writes a complete card at the end.

Runs on Windows, Mac, Android and iPhone, in English or Simplified Chinese, and everything stays on your own device.

<p align="center"><b><a href="https://github.com/Shikasar7/CicaTavern/releases/latest">Download</a></b> · <a href="docs/guide.en.md">User guide</a> · <a href="docs/help/README.md">Help (Chinese)</a> · <a href="CHANGELOG.md">Changelog (Chinese)</a></p>

<p align="center"><img src="docs/screenshots/chat.jpg" alt="The chat screen: story text, clickable action choices, a generated illustration, and on the right the state variables and this turn's cache hit" width="880"></p>

## Features

### High cache hit rates

<p align="center"><img src="docs/screenshots/cache.png" alt="The prefix stays fixed and each turn only appends, so long chats hit the cache every turn; rebuilding the prompt each turn, as is common, breaks the cache" width="880"></p>

The card, world books and preset sit in a fixed prefix and each turn only appends, so a long chat hits the cache for over 90% of every turn.

### Long-term memory (Beta)

<p align="center"><img src="web/whatsnew/2.3.0-memory.webp" alt="Long-term memory: mentioning the pier recalls the promise made in rounds 5–6; the memory book keeps people, events and promises as separate entries" width="880"></p>

People, promises and foreshadowing from older parts of the story go into a memory book and come back when the story mentions them, without breaking the cache or needing any extra API.

### SillyTavern-compatible

<p align="center"><img src="web/whatsnew/2.6.1-statusart.webp" alt="Pictures on the status bar: small portraits before names, a book of places drawn as a map, a type-matchup wheel and a companion's form chain" width="720"></p>

SillyTavern cards, world books, presets, regex, MVU variables, the status bars inside cards and Tavern Helper scripts all work, and SillyTavern chats import directly.

### Visual novel mode

<p align="center"><img src="docs/screenshots/vn.jpg" alt="Visual novel mode: a teahouse in the rain as the background, the speaking character's sprite in front, a text box showing one line at a time" width="880"></p>
<p align="center"><img src="docs/screenshots/vn-sprites.jpg" alt="When someone else speaks, their sprite steps in: the steward with his ledger, and the name plate in his colour" width="49%"> <img src="docs/screenshots/vn-choices.jpg" alt="At the end of a reply the choices open in the middle of the picture; 1–4 picks one, ✎ edits it first" width="49%"></p>

One switch turns the story into a game screen: scene backgrounds, the speaker's sprite, one line at a time, and the choices in the middle of the picture.

### Game rules mode (in development)

<p align="center"><img src="docs/screenshots/rules-themes.jpg" alt="One story in five looks: choices, dice, a fight, a skill and victory, in Simple dark, Simple light, Classical, Retro console and Color block" width="880"></p>
<p align="center"><img src="docs/screenshots/rules-dice.jpg" alt="A dice check: the twenty-sided die shows 17, plus 1 makes 18 against 12, a success" width="49%"> <img src="docs/screenshots/rules-battle.jpg" alt="The fight screen: two wolves and a bandit chief on a mountain road, with health, energy and the attack, skill, item, guard and flee actions below" width="49%"></p>

Dice checks, turn-based fights, levels and growth: the program decides what happens and the model writes it. On per card, off by default.

### Pictures, voices and characters that keep their look

Illustrate a scene with one click through an OpenAI-compatible API, Gemini, NovelAI, ComfyUI or SD WebUI. Read-aloud uses cloud voices, the browser's voices or a local model, and you can speak your messages too. Each character's face, outfit and voice are kept, so they stay the same person in every picture.

### Guided card creator

<p align="center"><img src="docs/screenshots/forge-talk.png" alt="The card creator: every option comes with a sample line, the writing style is picked from short samples, and the sketch on the right updates with each choice" width="880"></p>
<p align="center"><img src="docs/screenshots/forge-polish.jpg" alt="Polish and portrait: the portrait, greetings and every world book entry can be edited, and the saved card can be exported as a PNG" width="880"></p>

Not sure what you want yet? The creator asks you round by round, settles a plan with you, then writes the world book, greetings and status bar. The exported PNG works in SillyTavern too.

### On your computer and your phone

<img src="docs/screenshots/phone.jpg" alt="The chat screen on a phone" width="260" align="right">

- With the computer on, open the passcode link in your phone's browser and play.
- Or install the Android app, or the iPhone and iPad [beta](https://testflight.apple.com/join/wsT7kT4b), and play without the computer.
- The interface is laid out for phone screens.

<br clear="right">

## Getting started (Windows)

1. Download the zip, unzip it anywhere and double-click **CicaTavern.exe**. If Windows says "Windows protected your PC" the first time, click **More info → Run anyway**.
2. At the bottom of the model picker in the top bar, choose 管理模型供应商… (Manage providers) → 添加 (Add) → 从模板开始 (Start from a template), pick a provider and paste your API key.
3. Top left, 导入角色卡、世界书或预设 (Import card, world book or preset): choose a SillyTavern card, then 新对话 (New chat).

Installing on Mac, Android and iPhone, and the full notes on updates, proxies, pictures, read-aloud, privacy and more, are in the **[user guide](docs/guide.en.md)**.

## Support the project

Building CicaTavern has taken over 20 billion tokens so far, and since October it has shipped 50+ versions in about a month.

<p align="center"><img src="docs/screenshots/support-usage.png" alt="Development usage: 26.1 billion tokens and 76,000 requests from October to November" width="720"></p>

If you're having fun and would like to support the author, you can buy them a bubble tea. Thank you so much! With your support the updates will come even faster (ง •̀_•́)ง

<p align="center"><img src="docs/screenshots/support-qr.webp" alt="Tip code: scan with WeChat or Alipay" width="280"></p>

Thank you all for your love and feedback; you are what keeps me going~

## License

[GNU AGPL-3.0](LICENSE), copyright Shikasar7. Free to use, commercial use included; a modified version you distribute must be open source too. Before contributing code, please read [CONTRIBUTING.md](CONTRIBUTING.md).

This project is not affiliated with Anthropic, OpenAI, Google or any other model provider; costs are billed to your own account. Character cards, world books and presets belong to their original authors.
