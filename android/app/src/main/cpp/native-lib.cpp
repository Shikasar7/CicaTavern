// Starts nodejs-mobile's embedded Node with the given argv, on the calling
// thread, and returns its exit code. Node can only start once per process.
//
// stdout/stderr point straight at the log file the Java side passes. Not a
// pipe drained by a thread: when Node hits a fatal error and exits, the app
// aborts while tearing down (nodejs-mobile cannot exit cleanly), and whatever
// was still in a pipe would be lost. Writes to the file land synchronously.
#include <jni.h>
#include <node.h>

#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

void redirect_output(const char *log_path) {
    int fd = open(log_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd < 0) return;
    dup2(fd, STDOUT_FILENO);
    dup2(fd, STDERR_FILENO);
    close(fd);
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_app_cicatavern_NodeRuntime_startNode(JNIEnv *env, jclass, jobjectArray arguments, jstring logPath) {
    const char *log = env->GetStringUTFChars(logPath, nullptr);
    redirect_output(log);
    env->ReleaseStringUTFChars(logPath, log);

    // Node (libuv) expects argv's strings to sit next to each other in one block.
    jsize count = env->GetArrayLength(arguments);
    std::vector<std::string> values;
    size_t total = 0;
    for (jsize i = 0; i < count; i++) {
        auto item = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *text = env->GetStringUTFChars(item, nullptr);
        values.emplace_back(text);
        env->ReleaseStringUTFChars(item, text);
        env->DeleteLocalRef(item);
        size_t needed = values.back().size() + 1;
        if (__builtin_add_overflow(total, needed, &total)) return jint(-1);
    }
    char *block = (char *) calloc(total, 1);
    if (block == nullptr) return jint(-1);
    std::vector<char *> argv;
    char *at = block;
    for (const auto &value : values) {
        memcpy(at, value.c_str(), value.size() + 1);
        argv.push_back(at);
        at += value.size() + 1;
    }
    return jint(node::Start(count, argv.data()));
}
