/*
 * A minimal, complete Premation native plugin.
 *
 * One effect — `exposure` — over premultiplied 32-bit float RGBA. It is
 * deliberately arithmetic a shader could do in three lines: the point of the
 * example is the CONTRACT around the arithmetic, not the arithmetic. Everything
 * an author has to get right is here and nothing else is:
 *
 *   • the version check the host makes before anything else runs
 *   • `register` as the one place a global is written (AE's GLOBAL_SETUP rule)
 *   • `describe` telling the host which calls exist, what pixel layout this
 *     addon wants, and whether two calls may be in flight at once
 *   • `render` writing into the OUTPUT buffer it was handed and returning it
 *   • `identity` as the cheap answer when the parameters mean "do nothing"
 *   • `dispose` freeing what register allocated
 *
 * Build: see ../../README.md. node-gyp and cmake-js are both wired up; neither
 * is run by the editor's build or by its CI.
 */

#include <napi.h>

#include <cmath>
#include <string>

#include "motion_plugin_abi.h"

namespace {

/*
  The only mutable global, written once in register and read-only afterwards.

  That is not a style preference — it is the rule that makes `threadSafety:
  "full"` truthful. The host is allowed to have two render calls in flight in
  this process at once; anything written during a render has to be per-call or
  it is a race that shows up as one wrong frame in a hundred.
*/
struct Plugin {
  bool registered = false;
  std::string plugin_id;
  std::string plugin_dir;
};

Plugin g_plugin;

Napi::Value AbiVersion(const Napi::CallbackInfo& info) {
  // No allocation, no I/O, no throw: the host calls this while it is still
  // deciding whether it speaks this addon's language.
  return Napi::Number::New(info.Env(), MOTION_PLUGIN_ABI_VERSION);
}

Napi::Value Register(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (info.Length() < 1 || !info[0].IsObject()) {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "register was called without host info"));
    return result;
  }

  Napi::Object host = info[0].As<Napi::Object>();
  g_plugin.plugin_id = host.Get("pluginId").ToString().Utf8Value();
  g_plugin.plugin_dir = host.Get("pluginDir").ToString().Utf8Value();
  g_plugin.registered = true;

  // This is where a real addon opens its model, its LUT or its licence file,
  // under `plugin_dir`. Failing here is how you refuse the load with a sentence
  // the user is shown, instead of failing on the first frame they render.
  result.Set("ok", Napi::Boolean::New(env, true));
  return result;
}

Napi::Value Describe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  out.Set("name", Napi::String::New(env, "Example Native Effects"));
  out.Set("version", Napi::String::New(env, "1.0.0"));

  Napi::Array calls = Napi::Array::New(env, 1);
  calls.Set(uint32_t(0), Napi::String::New(env, MOTION_PLUGIN_CALL_EFFECT));
  out.Set("calls", calls);

  out.Set("pixelFormat", Napi::String::New(env, MOTION_PLUGIN_PIXELS_F32_PREMUL));
  // `full`: this addon writes nothing outside the buffers of the call it is in,
  // so the host may run two at once. Claiming this when it is not true is the
  // most expensive mistake available in this file.
  out.Set("threadSafety", Napi::String::New(env, MOTION_PLUGIN_THREAD_FULL));

  Napi::Object effect = Napi::Object::New(env);
  effect.Set("id", Napi::String::New(env, "exposure"));
  // No `expand`: exposure does not write outside the layer box. Declaring reach
  // an effect does not use enlarges every buffer it touches for nothing.
  Napi::Array effects = Napi::Array::New(env, 1);
  effects.Set(uint32_t(0), effect);
  out.Set("effects", effects);

  return out;
}

Napi::Value Fail(Napi::Env env, const char* message) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("ok", Napi::Boolean::New(env, false));
  out.Set("error", Napi::String::New(env, message));
  return out;
}

Napi::Value Render(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_plugin.registered) return Fail(env, "render was called before register");
  if (info.Length() < 1 || !info[0].IsObject()) return Fail(env, "render was called without a request");

  Napi::Object request = info[0].As<Napi::Object>();
  const std::string call = request.Get("call").ToString().Utf8Value();
  if (call != MOTION_PLUGIN_CALL_EFFECT) {
    return Fail(env, "this addon implements only the effect call");
  }

  const std::string effect_id = request.Get("effectId").ToString().Utf8Value();
  if (effect_id != "exposure") return Fail(env, "unknown effect id");

  Napi::Value params_value = request.Get("params");
  double stops = 0.0;
  if (params_value.IsObject()) {
    Napi::Value raw = params_value.As<Napi::Object>().Get("stops");
    if (raw.IsNumber()) stops = raw.As<Napi::Number>().DoubleValue();
  }

  /*
    The identity answer.

    Returning `identity: true` tells the host the input is already the result,
    so it reuses the buffer it already has and skips the copy back. For a
    parameter animated through zero this is most of the frames in a comp.
  */
  if (stops == 0.0) {
    Napi::Object out = Napi::Object::New(env);
    out.Set("ok", Napi::Boolean::New(env, true));
    out.Set("identity", Napi::Boolean::New(env, true));
    return out;
  }

  if (!request.Get("input").IsTypedArray() || !request.Get("output").IsTypedArray()) {
    return Fail(env, "input and output must be Float32Arrays");
  }
  Napi::Float32Array input = request.Get("input").As<Napi::Float32Array>();
  Napi::Float32Array output = request.Get("output").As<Napi::Float32Array>();
  if (input.ElementLength() != output.ElementLength()) {
    return Fail(env, "input and output are different sizes");
  }

  const float gain = static_cast<float>(std::pow(2.0, stops));
  const size_t count = input.ElementLength();
  const float* src = input.Data();
  float* dst = output.Data();

  // Premultiplied RGBA: scaling RGB and leaving A is the correct exposure here.
  // In straight alpha the same loop would brighten transparent pixels' colour
  // and change the edge of every soft mask.
  for (size_t i = 0; i + 3 < count; i += 4) {
    dst[i + 0] = src[i + 0] * gain;
    dst[i + 1] = src[i + 1] * gain;
    dst[i + 2] = src[i + 2] * gain;
    dst[i + 3] = src[i + 3];
  }

  Napi::Object out = Napi::Object::New(env);
  out.Set("ok", Napi::Boolean::New(env, true));
  out.Set("output", output);
  return out;
}

Napi::Value Dispose(const Napi::CallbackInfo& info) {
  g_plugin.registered = false;
  g_plugin.plugin_id.clear();
  g_plugin.plugin_dir.clear();
  // Not called when the process is killed for hanging or crashing. Nothing
  // whose absence would corrupt the user's disk may depend on reaching here.
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(MOTION_PLUGIN_EXPORT_ABI_VERSION, Napi::Function::New(env, AbiVersion));
  exports.Set(MOTION_PLUGIN_EXPORT_REGISTER, Napi::Function::New(env, Register));
  exports.Set(MOTION_PLUGIN_EXPORT_DESCRIBE, Napi::Function::New(env, Describe));
  exports.Set(MOTION_PLUGIN_EXPORT_RENDER, Napi::Function::New(env, Render));
  exports.Set(MOTION_PLUGIN_EXPORT_DISPOSE, Napi::Function::New(env, Dispose));
  return exports;
}

}  // namespace

NODE_API_MODULE(motion_example, Init)
