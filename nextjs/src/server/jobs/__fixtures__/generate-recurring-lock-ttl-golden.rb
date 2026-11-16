# frozen_string_literal: true

# Produces recurring-lock-ttl.golden.json by running app/models/concerns/recurring_lock_ttl.rb
# itself (with the fugit/activesupport versions from Gemfile.lock) over every `recurring_lock_ttl`
# declaration in app/sidekiq. The registry generator recomputes these in TypeScript; the test
# compares the two.
#
#   gem install --conservative activesupport:8.1.3.1 fugit:1.11.1 et-orbi:1.2.11
#   ruby generate-recurring-lock-ttl-golden.rb
gem "activesupport", "8.1.3.1"
gem "fugit", "1.11.1"
require "json"
require "pathname"
require "yaml"
require "active_support"
require "active_support/core_ext"
require "fugit"

REPO_ROOT = Pathname.new(__dir__).join("../../../../..").expand_path

module Rails
  def self.root = REPO_ROOT
end

require REPO_ROOT.join("app/models/concerns/recurring_lock_ttl.rb").to_s

# Only duration arithmetic over the file's own constants, e.g. `SCAN_TIME_BUDGET + 1.hour`.
DURATION_EXPR = /\A[A-Z_0-9]*(?:[\s+*]+|\d+\.(?:second|minute|hour|day)s?|[A-Z_][A-Z_0-9]*)*\z/

def evaluate_duration(expression, source)
  scope = Module.new
  source.scan(/^\s*([A-Z][A-Z_0-9]*) = (.+)$/) do |name, rhs|
    scope.const_set(name, scope.module_eval(rhs)) if rhs.match?(DURATION_EXPR)
  end
  raise "cannot evaluate #{expression}" unless expression.match?(DURATION_EXPR)
  scope.module_eval(expression)
end

ttls = REPO_ROOT.glob("app/sidekiq/*.rb").sort.filter_map do |path|
  source = path.read
  match = source.match(/^\s*recurring_lock_ttl max_attempt: (.+)$/) or next
  max_attempt = evaluate_duration(match[1].strip, source)
  class_name = source[/^class (\w+)/, 1]
  [class_name, RecurringLockTtl.ttl_for(class_name, max_attempt:).to_i]
end.to_h

File.write(File.join(__dir__, "recurring-lock-ttl.golden.json"), JSON.pretty_generate(ttls) + "\n")
puts "wrote #{ttls.size} ttls"
