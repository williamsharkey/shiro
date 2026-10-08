# frozen_string_literal: true
# Shiro: ruby.wasm lacks the io/wait extension. IO in WASI blocks, so
# waiting for readiness returns at once. Methods core Ruby already has are kept.
class IO
  { wait: ->(*) { self }, wait_readable: ->(*) { self }, wait_writable: ->(*) { self },
    wait_priority: ->(*) { self }, ready?: -> { true }, nread: -> { 0 } }.each do |name, body|
    define_method(name, &body) unless method_defined?(name)
  end
end
