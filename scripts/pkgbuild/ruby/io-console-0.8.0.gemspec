# -*- encoding: utf-8 -*-
# Shiro: a stand-in for the io-console default gem (ruby.wasm has no
# io/console extension; site_ruby/io/console.rb is a pure-Ruby stub), so
# gems depending on it (reline, and through it irb) activate.

Gem::Specification.new do |s|
  s.name = "io-console".freeze
  s.version = "0.8.0".freeze
  s.require_paths = ["lib".freeze]
  s.authors = ["Nobu Nakada".freeze]
  s.files = ["io/console.rb".freeze, "io/console/size.rb".freeze]
  s.homepage = "https://github.com/ruby/io-console".freeze
  s.licenses = ["Ruby".freeze, "BSD-2-Clause".freeze]
  s.required_ruby_version = Gem::Requirement.new(">= 2.6.0".freeze)
  s.summary = "Console interface".freeze
end
