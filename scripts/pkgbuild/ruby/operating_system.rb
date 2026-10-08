# frozen_string_literal: true
# Shiro: RubyGems loads this at startup (the hook distributions use for
# their defaults). ruby.wasm has no threads, so minitest must not start
# its parallel executor's workers.
ENV["MT_CPU"] ||= "0"
