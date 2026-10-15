#include <node.h>
#include <v8-profiler.h>

#include <cstddef>
#include <string>

namespace {

v8::CpuProfiler* profiler = nullptr;
v8::ProfilerId active_profile = 0;
unsigned int next_profile = 0;
unsigned int serialization_count = 0;

class ProfileOutput final : public v8::OutputStream {
 public:
  WriteResult WriteAsciiChunk(char* data, int size) override {
    value_.append(data, static_cast<size_t>(size));
    return kContinue;
  }

  void EndOfStream() override {}
  int GetChunkSize() override { return 16 * 1024; }

  const std::string& value() const { return value_; }

 private:
  std::string value_;
};

void Throw(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::Error(
      v8::String::NewFromUtf8(isolate, message).ToLocalChecked()));
}

v8::Local<v8::String> Key(v8::Isolate* isolate, const char* value) {
  return v8::String::NewFromUtf8(isolate, value).ToLocalChecked();
}

void Set(v8::Local<v8::Context> context,
         v8::Local<v8::Object> object,
         const char* key,
         v8::Local<v8::Value> value) {
  object->Set(context, Key(context->GetIsolate(), key), value).Check();
}

bool EnsureProfiler(v8::Isolate* isolate) {
  if (profiler) return true;
  profiler = v8::CpuProfiler::New(
      isolate, v8::kDebugNaming, v8::kEagerLogging);
  if (!profiler) return false;
  profiler->SetSamplingInterval(10000);
  return true;
}

void Create(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (!EnsureProfiler(isolate)) {
    Throw(isolate, "could not create eager CpuProfiler");
    return;
  }
  args.GetReturnValue().Set(v8::Boolean::New(isolate, true));
}

void Start(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (active_profile != 0) {
    Throw(isolate, "a CpuProfiler capture is already active");
    return;
  }
  if (!EnsureProfiler(isolate)) {
    Throw(isolate, "could not create eager CpuProfiler");
    return;
  }

  const auto context = isolate->GetCurrentContext();
  unsigned int max_samples = 64;
  if (args.Length() > 0) {
    max_samples = args[0]->Uint32Value(context).FromMaybe(64);
  }
  if (max_samples == 0) {
    Throw(isolate, "max_samples must be positive");
    return;
  }

  const std::string title =
      "papercusp-eager-cpu-profiler-" + std::to_string(++next_profile);
  const auto result = profiler->Start(
      v8::String::NewFromUtf8(isolate, title.c_str()).ToLocalChecked(),
      v8::kLeafNodeLineNumbers,
      true,
      max_samples);
  if (result.status != v8::CpuProfilingStatus::kStarted) {
    Throw(isolate, "eager CpuProfiler failed to start");
    return;
  }

  active_profile = result.id;
  args.GetReturnValue().Set(v8::Integer::NewFromUnsigned(isolate, active_profile));
}

void Finish(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (!profiler || active_profile == 0) {
    Throw(isolate, "no eager CpuProfiler capture is active");
    return;
  }

  const bool serialize = args.Length() > 0 && args[0]->IsTrue();
  const bool dispose = args.Length() > 1 && args[1]->IsTrue();
  v8::CpuProfile* profile = profiler->Stop(active_profile);
  active_profile = 0;
  if (!profile) {
    Throw(isolate, "eager CpuProfiler did not return a stopped profile");
    return;
  }

  const int sample_count = profile->GetSamplesCount();
  std::string serialized;
  if (serialize) {
    ProfileOutput output;
    profile->Serialize(&output);
    serialized = output.value();
    serialization_count++;
  }
  profile->Delete();

  if (dispose && profiler) {
    profiler->Dispose();
    profiler = nullptr;
  }

  const auto context = isolate->GetCurrentContext();
  const auto result = v8::Object::New(isolate);
  Set(context, result, "serialized", v8::Boolean::New(isolate, serialize));
  Set(context, result, "disposed", v8::Boolean::New(isolate, dispose));
  Set(context, result, "sampleCount", v8::Integer::New(isolate, sample_count));
  if (serialize) {
    const auto json = v8::String::NewFromUtf8(
        isolate,
        serialized.c_str(),
        v8::NewStringType::kNormal,
        static_cast<int>(serialized.size())).ToLocalChecked();
    Set(context, result, "profileJson", json);
  } else {
    Set(context, result, "profileJson", v8::Null(isolate));
  }
  args.GetReturnValue().Set(result);
}

void Dispose(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (profiler) {
    if (active_profile != 0) {
      v8::CpuProfile* profile = profiler->Stop(active_profile);
      active_profile = 0;
      if (profile) profile->Delete();
    }
    profiler->Dispose();
    profiler = nullptr;
  }
  args.GetReturnValue().Set(v8::Boolean::New(isolate, true));
}

void SerializationCount(const v8::FunctionCallbackInfo<v8::Value>& args) {
  args.GetReturnValue().Set(
      v8::Integer::NewFromUnsigned(args.GetIsolate(), serialization_count));
}

}  // namespace

NODE_MODULE_INIT() {
  NODE_SET_METHOD(exports, "create", Create);
  NODE_SET_METHOD(exports, "start", Start);
  NODE_SET_METHOD(exports, "finish", Finish);
  NODE_SET_METHOD(exports, "dispose", Dispose);
  NODE_SET_METHOD(exports, "serializationCount", SerializationCount);
}
