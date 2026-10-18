// CicaTavern.exe, the Windows launcher (built by scripts/build-launcher.mjs
// with MSVC; the icon, version and manifest come from CicaTavern.rc).
//
//   CicaTavern.exe [--port N] [--data DIR] ...
//       Runs bin\launch.mjs with the package's runtime\node.exe (or, in a
//       source checkout without runtime\, the node.exe on PATH) and no console
//       window; launch.mjs starts the server and opens the app window. When it
//       fails, a message box shows what launch.mjs printed.
//   CicaTavern.exe --create-shortcut [--start-menu] [--dir DIR]
//       Puts CicaTavern.lnk (pointing here) on the desktop, in the Start menu,
//       or in DIR. Prints the shortcut's path.
//   CicaTavern.exe --retarget-shortcuts OLD NEW [--dir DIR]...
//       Shortcuts on the desktop, in the Start menu and pinned to the taskbar
//       (or in DIR) that open the folder OLD now open NEW: the in-app updater's
//       switch-over (server/update/). Prints each shortcut changed.
//   CicaTavern.exe --list-shortcuts [--dir DIR]...
//       Prints each shortcut there: file, target, arguments, start folder, icon.
//
// Shortcuts go through the shell's own IShellLink in this process: no script
// is written or run. Output is UTF-8 on stdout; errors go to stderr with exit
// code 1. With CICATAVERN_LAUNCHER_QUIET=1 the start's error goes to stderr
// instead of a message box (tests).
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <knownfolders.h>

#include <string>
#include <vector>

namespace {

const wchar_t kTitle[] = L"CicaTavern";

std::wstring ModulePath() {
  std::wstring path(MAX_PATH, L'\0');
  for (;;) {
    DWORD n = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (n < path.size()) {
      path.resize(n);
      return path;
    }
    path.resize(path.size() * 2);
  }
}

std::wstring ParentOf(const std::wstring& path) {
  size_t cut = path.find_last_of(L"\\/");
  return cut == std::wstring::npos ? path : path.substr(0, cut);
}

std::wstring Join(const std::wstring& a, const std::wstring& b) {
  if (a.empty()) return b;
  return (a.back() == L'\\' || a.back() == L'/') ? a + b : a + L"\\" + b;
}

bool IsFile(const std::wstring& path) {
  DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

bool IsFolder(const std::wstring& path) {
  DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

std::string Utf8(const std::wstring& text) {
  if (text.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring Wide(const std::string& text) {
  if (text.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), n);
  return out;
}

void Write(DWORD which, const std::wstring& text) {
  HANDLE handle = GetStdHandle(which);
  if (!handle || handle == INVALID_HANDLE_VALUE) return;
  std::string bytes = Utf8(text);
  DWORD written = 0;
  WriteFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
}

void Print(const std::wstring& line) { Write(STD_OUTPUT_HANDLE, line + L"\n"); }

int Error(const std::wstring& text) {
  Write(STD_ERROR_HANDLE, text + L"\n");
  return 1;
}

bool Quiet() {
  wchar_t value[8] = {};
  return GetEnvironmentVariableW(L"CICATAVERN_LAUNCHER_QUIET", value, 8) > 0 && value[0] == L'1';
}

/** The start failed: a message box for a person, stderr for tests. */
int Fail(const std::wstring& text) {
  if (Quiet()) return Error(text);
  MessageBoxW(nullptr, text.c_str(), kTitle, MB_OK | MB_ICONWARNING);
  return 1;
}

/** One argument as CommandLineToArgvW reads it back. */
std::wstring Quote(const std::wstring& arg) {
  if (!arg.empty() && arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    out.push_back(c);
    slashes = 0;
  }
  out.append(slashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

std::wstring Trim(const std::wstring& text) {
  size_t start = text.find_first_not_of(L" \t\r\n");
  if (start == std::wstring::npos) return {};
  size_t end = text.find_last_not_of(L" \t\r\n");
  return text.substr(start, end - start + 1);
}

// ─── Start ──────────────────────────────────────────────────────────────

/**
 * The package's own runtime\node.exe; in a source checkout (no runtime\), the
 * node.exe on PATH. A package whose runtime\ lost node.exe (an antivirus) gets
 * none rather than some other Node.
 */
std::wstring FindNode(const std::wstring& dir) {
  std::wstring bundled = Join(dir, L"runtime\\node.exe");
  if (IsFile(bundled)) return bundled;
  if (IsFolder(Join(dir, L"runtime"))) return {};
  wchar_t found[MAX_PATH] = {};
  DWORD n = SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr);
  return n > 0 && n < MAX_PATH ? std::wstring(found) : std::wstring();
}

struct Reader {
  HANDLE pipe;
  std::string text;
};

DWORD WINAPI ReadAll(void* param) {
  auto* reader = static_cast<Reader*>(param);
  char buffer[4096];
  DWORD n = 0;
  while (ReadFile(reader->pipe, buffer, sizeof buffer, &n, nullptr) && n > 0) {
    if (reader->text.size() < 64 * 1024) reader->text.append(buffer, n);
  }
  return 0;
}

int Start(const std::wstring& dir, const std::vector<std::wstring>& args) {
  std::wstring script = Join(dir, L"bin\\launch.mjs");
  std::wstring node = FindNode(dir);
  if (node.empty()) {
    return Fail(IsFolder(Join(dir, L"runtime"))
      ? L"找不到 runtime\\node.exe。\n\n可能被杀毒软件隔离了：从隔离区恢复它，或者把安装包重新解压一遍。\n\n" + dir
      : L"找不到 Node.js：安装 Node 24 以上，或者用发布包里的 CicaTavern.exe。");
  }
  if (!IsFile(script)) return Fail(L"找不到 bin\\launch.mjs：安装文件夹不完整，把安装包重新解压一遍。\n\n" + dir);

  std::wstring line = Quote(node) + L" " + Quote(script);
  for (const auto& arg : args) line += L" " + Quote(arg);

  SECURITY_ATTRIBUTES inherit = {sizeof inherit, nullptr, TRUE};
  HANDLE readEnd = nullptr;
  HANDLE writeEnd = nullptr;
  if (!CreatePipe(&readEnd, &writeEnd, &inherit, 0)) return Fail(L"没能启动：建立管道失败。");
  SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, nullptr);

  STARTUPINFOW startup = {sizeof startup};
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = nul;
  startup.hStdOutput = nul;
  startup.hStdError = writeEnd;
  PROCESS_INFORMATION process = {};
  std::vector<wchar_t> commandLine(line.begin(), line.end());
  commandLine.push_back(L'\0');
  BOOL started = CreateProcessW(node.c_str(), commandLine.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, dir.c_str(), &startup, &process);
  DWORD startError = GetLastError();
  CloseHandle(writeEnd);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!started) {
    CloseHandle(readEnd);
    return Fail(L"运行不了 " + node + L"（错误 " + std::to_wstring(startError) + L"）。");
  }

  Reader reader = {readEnd, {}};
  HANDLE thread = CreateThread(nullptr, 0, ReadAll, &reader, 0, nullptr);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  // launch.mjs is done; the server it started in the background does not hold the pipe.
  if (thread && WaitForSingleObject(thread, 1500) == WAIT_TIMEOUT) CancelSynchronousIo(thread);
  if (thread) {
    WaitForSingleObject(thread, 1000);
    CloseHandle(thread);
  }
  CloseHandle(readEnd);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (code == 0) return 0;
  std::wstring text = Trim(Wide(reader.text));
  if (text.size() > 1800) text = L"…" + text.substr(text.size() - 1800);
  return Fail(text.empty() ? L"CicaTavern 没能启动（退出代码 " + std::to_wstring(code) + L"）。" : text);
}

// ─── Shortcuts ──────────────────────────────────────────────────────────

std::wstring KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR path = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &path))) out = path;
  CoTaskMemFree(path);
  return out;
}

/** The desktop, the Start menu's Programs (one level down too) and the pinned taskbar. */
std::vector<std::wstring> StandardFolders() {
  std::vector<std::wstring> folders;
  folders.push_back(KnownFolder(FOLDERID_Desktop));
  std::wstring programs = KnownFolder(FOLDERID_Programs);
  folders.push_back(programs);
  if (!programs.empty()) {
    WIN32_FIND_DATAW found;
    HANDLE search = FindFirstFileW(Join(programs, L"*").c_str(), &found);
    if (search != INVALID_HANDLE_VALUE) {
      do {
        std::wstring name = found.cFileName;
        if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && name != L"." && name != L"..") folders.push_back(Join(programs, name));
      } while (FindNextFileW(search, &found));
      FindClose(search);
    }
  }
  std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
  if (!roaming.empty()) folders.push_back(Join(roaming, L"Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"));
  return folders;
}

std::vector<std::wstring> LinksIn(const std::vector<std::wstring>& folders) {
  std::vector<std::wstring> links;
  for (const auto& folder : folders) {
    if (folder.empty() || !IsFolder(folder)) continue;
    WIN32_FIND_DATAW found;
    HANDLE search = FindFirstFileW(Join(folder, L"*.lnk").c_str(), &found);
    if (search == INVALID_HANDLE_VALUE) continue;
    do {
      if (!(found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) links.push_back(Join(folder, found.cFileName));
    } while (FindNextFileW(search, &found));
    FindClose(search);
  }
  return links;
}

struct Link {
  IShellLinkW* shell = nullptr;
  IPersistFile* file = nullptr;
  ~Link() {
    if (file) file->Release();
    if (shell) shell->Release();
  }
  bool Make() {
    return SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&shell))) &&
           SUCCEEDED(shell->QueryInterface(IID_PPV_ARGS(&file)));
  }
};

struct Fields {
  std::wstring target, args, dir, icon;
  int iconIndex = 0;
};

bool ReadLink(Link& link, const std::wstring& path, Fields& fields) {
  if (FAILED(link.file->Load(path.c_str(), STGM_READ))) return false;
  std::vector<wchar_t> buffer(32768);
  if (SUCCEEDED(link.shell->GetPath(buffer.data(), static_cast<int>(buffer.size()), nullptr, SLGP_RAWPATH))) fields.target = buffer.data();
  buffer[0] = 0;
  if (SUCCEEDED(link.shell->GetArguments(buffer.data(), static_cast<int>(buffer.size())))) fields.args = buffer.data();
  buffer[0] = 0;
  if (SUCCEEDED(link.shell->GetWorkingDirectory(buffer.data(), static_cast<int>(buffer.size())))) fields.dir = buffer.data();
  buffer[0] = 0;
  if (SUCCEEDED(link.shell->GetIconLocation(buffer.data(), static_cast<int>(buffer.size()), &fields.iconIndex))) fields.icon = buffer.data();
  return true;
}

std::wstring Lower(std::wstring text) {
  CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
  return text;
}

std::wstring StripSlash(std::wstring path) {
  while (path.size() > 3 && (path.back() == L'\\' || path.back() == L'/')) path.pop_back();
  return path;
}

/** OLD swapped for NEW wherever it is a whole path (…\CicaTavern-1.3.1-win-x64-backup is not it), any case. */
std::wstring Swap(const std::wstring& value, const std::wstring& from, const std::wstring& to) {
  if (from.empty()) return value;
  std::wstring lower = Lower(value);
  std::wstring needle = Lower(from);
  std::wstring out;
  size_t at = 0;
  for (;;) {
    size_t hit = lower.find(needle, at);
    if (hit == std::wstring::npos) break;
    size_t end = hit + needle.size();
    bool whole = end == value.size() || value[end] == L'\\' || value[end] == L'/' || value[end] == L'"' || value[end] == L',';
    out += value.substr(at, hit - at);
    out += whole ? to : value.substr(hit, needle.size());
    at = end;
  }
  return out + value.substr(at);
}

std::vector<std::wstring> FoldersFrom(const std::vector<std::wstring>& args, size_t from) {
  std::vector<std::wstring> folders;
  for (size_t i = from; i + 1 < args.size(); ++i) {
    if (args[i] == L"--dir") folders.push_back(args[++i]);
  }
  return folders.empty() ? StandardFolders() : folders;
}

bool Has(const std::vector<std::wstring>& args, const wchar_t* flag) {
  for (const auto& arg : args) {
    if (arg == flag) return true;
  }
  return false;
}

int CreateShortcut(const std::wstring& exe, const std::wstring& dir, const std::vector<std::wstring>& args) {
  std::wstring folder;
  for (size_t i = 0; i + 1 < args.size(); ++i) {
    if (args[i] == L"--dir") folder = args[i + 1];
  }
  if (folder.empty()) folder = KnownFolder(Has(args, L"--start-menu") ? FOLDERID_Programs : FOLDERID_Desktop);
  if (folder.empty() || !IsFolder(folder)) return Error(L"找不到要放快捷方式的文件夹。");
  std::wstring path = Join(folder, L"CicaTavern.lnk");
  Link link;
  if (!link.Make()) return Error(L"建不了快捷方式（IShellLink 不可用）。");
  bool package = IsFile(Join(dir, L"edition.json"));
  link.shell->SetPath(exe.c_str());
  link.shell->SetArguments(L"");
  link.shell->SetWorkingDirectory(dir.c_str());
  link.shell->SetIconLocation(exe.c_str(), 0);
  link.shell->SetDescription(package ? L"用自己的模型 API 游玩角色卡" : L"CicaTavern 个人版");
  if (FAILED(link.file->Save(path.c_str(), TRUE))) return Error(L"快捷方式保存不了：" + path);
  Print(path);
  return 0;
}

int RetargetShortcuts(const std::vector<std::wstring>& args) {
  if (args.size() < 3) return Error(L"用法：--retarget-shortcuts <旧文件夹> <新文件夹> [--dir <文件夹>]");
  std::wstring from = StripSlash(args[1]);
  std::wstring to = StripSlash(args[2]);
  int changed = 0;
  for (const auto& path : LinksIn(FoldersFrom(args, 3))) {
    Link link;
    Fields fields;
    if (!link.Make() || FAILED(link.file->Load(path.c_str(), STGM_READWRITE)) || !ReadLink(link, path, fields)) continue;
    Fields next = {Swap(fields.target, from, to), Swap(fields.args, from, to), Swap(fields.dir, from, to), Swap(fields.icon, from, to), fields.iconIndex};
    if (next.target == fields.target && next.args == fields.args && next.dir == fields.dir && next.icon == fields.icon) continue;
    link.shell->SetPath(next.target.c_str());
    link.shell->SetArguments(next.args.c_str());
    link.shell->SetWorkingDirectory(next.dir.c_str());
    link.shell->SetIconLocation(next.icon.c_str(), next.iconIndex);
    if (SUCCEEDED(link.file->Save(nullptr, TRUE))) {
      Print(path);
      ++changed;
    }
  }
  return 0;
}

int ListShortcuts(const std::vector<std::wstring>& args) {
  for (const auto& path : LinksIn(FoldersFrom(args, 1))) {
    Link link;
    Fields fields;
    if (!link.Make() || !ReadLink(link, path, fields)) continue;
    Print(path + L"\t" + fields.target + L"\t" + fields.args + L"\t" + fields.dir + L"\t" + fields.icon + L"," + std::to_wstring(fields.iconIndex));
  }
  return 0;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int count = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &count);
  std::vector<std::wstring> args;
  for (int i = 1; i < count; ++i) args.emplace_back(argv[i]);
  LocalFree(argv);
  std::wstring exe = ModulePath();
  std::wstring dir = ParentOf(exe);

  const std::wstring mode = args.empty() ? L"" : args[0];
  if (mode != L"--create-shortcut" && mode != L"--retarget-shortcuts" && mode != L"--list-shortcuts") return Start(dir, args);

  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return Error(L"COM 初始化失败。");
  int code = mode == L"--create-shortcut" ? CreateShortcut(exe, dir, args) : mode == L"--retarget-shortcuts" ? RetargetShortcuts(args) : ListShortcuts(args);
  CoUninitialize();
  return code;
}
