# frozen_string_literal: true

# Golden vectors for nextjs/src/lib/flags.ts: runs the real flag_shih_tzu `has_flags` of every
# model, with ActiveRecord's MySQL quoting, and records each flag's bit and generated SQL.
#
# Needs flag_shih_tzu and activerecord on the load path (run from the repo root):
#   bundle exec ruby nextjs/scripts/golden/flags.rb
require "json"
require "prism"
require "active_record"
require "active_record/connection_adapters/mysql/quoting"
require "flag_shih_tzu"

ROOT = File.expand_path("../../..", __dir__)
OUT = File.join(ROOT, "nextjs/src/lib/__fixtures__/flags.golden.json")

class MysqlQuoting
  include ActiveRecord::ConnectionAdapters::Quoting
  include ActiveRecord::ConnectionAdapters::MySQL::Quoting
end

def literal(node)
  case node
  when Prism::SymbolNode, Prism::StringNode then node.unescaped
  when Prism::IntegerNode then node.value
  when Prism::TrueNode then true
  when Prism::FalseNode then false
  else raise "Unsupported has_flags argument #{node.slice}"
  end
end

tables = JSON.parse(File.read(File.join(ROOT, "nextjs/prisma/relations/associations.json")))["models"].to_h { [_1["name"], _1["table_name"]] }

calls = []
Dir.glob(File.join(ROOT, "app/{models,modules}/**/*.rb")).sort.each do |path|
  stack = []
  visitor = Class.new(Prism::Visitor) do
    define_method(:visit_class_node) do |node|
      stack.push(node.constant_path.slice)
      super(node)
      stack.pop
    end
    define_method(:visit_call_node) do |node|
      if node.name == :has_flags && node.receiver.nil?
        args = {}
        node.arguments.arguments.each do |arg|
          arg.elements.each { |el| args[literal(el.key)] = literal(el.value) }
        end
        calls << { class_name: stack.join("::"), file: path.delete_prefix("#{ROOT}/"), args: }
      end
      super(node)
    end
  end
  Prism.parse_file(path).value.accept(visitor.new)
end

result = calls.to_h do |call|
  table = tables.fetch(call[:class_name])
  mapping = call[:args].select { |k, _| k.is_a?(Integer) }.transform_values(&:to_sym)
  options = call[:args].reject { |k, _| k.is_a?(Integer) }.transform_keys(&:to_sym)
  options[:flag_query_mode] = options[:flag_query_mode].to_sym if options[:flag_query_mode]

  model = Class.new(ActiveRecord::Base) do
    self.table_name = table
    define_singleton_method(:name) { call[:class_name] }
    define_singleton_method(:connection) { MysqlQuoting.new }
    include FlagShihTzu
  end
  model.has_flags(mapping.dup, options.merge(check_for_column: false))
  column = options[:column] || "flags"
  mode = model.flag_options[column][:flag_query_mode]

  flags = mapping.values.to_h do |flag|
    vectors = {
      "bit" => model.flag_mapping[column][flag].to_s,
      "condition" => model.public_send(:"#{flag}_condition"),
      "not_condition" => model.public_send(:"not_#{flag}_condition"),
      "aliased_condition" => model.public_send(:"#{flag}_condition", table_alias: "t2"),
      "set_sql" => model.set_flag_sql(flag, true),
      "unset_sql" => model.set_flag_sql(flag, false),
    }
    [flag.to_s, vectors]
  end
  [call[:class_name], { "file" => call[:file], "table" => table, "column" => column, "query_mode" => mode.to_s, "flags" => flags }]
end

File.write(OUT, JSON.pretty_generate(result) + "\n")
warn "Wrote #{result.size} models to #{OUT.delete_prefix("#{ROOT}/")}"
