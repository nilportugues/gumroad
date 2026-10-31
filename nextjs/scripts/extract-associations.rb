# frozen_string_literal: true

# Statically extracts every ActiveRecord association from app/models and app/modules into
# nextjs/prisma/relations/associations.json, which scripts/schema-rb-to-prisma.ts turns into
# Prisma relation fields.
#
# The output mirrors `Model.reflect_on_all_associations` (macro, name, options, plus the
# derived class_name/foreign_key/foreign_type/join_table Rails would compute), so a Rails
# runner dump can replace this script without touching the generator. Static parsing is used
# because booting Rails needs the full service stack.
#
# Run from the repo root with Ruby >= 3.4 (prism) and ActiveSupport on the load path:
#   bundle exec ruby nextjs/scripts/extract-associations.rb
require "json"
require "prism"
require "active_support"
require "active_support/core_ext/string"

ROOT = File.expand_path("../..", __dir__)
load File.join(ROOT, "config/initializers/inflections.rb")

MACROS = %i[belongs_to has_many has_one has_and_belongs_to_many].freeze

# Superclasses from gems whose tables live in our schema.
EXTERNAL_TABLES = {
  "Doorkeeper::Application" => "oauth_applications",
  "Doorkeeper::AccessToken" => "oauth_access_tokens",
  "Doorkeeper::AccessGrant" => "oauth_access_grants",
}.freeze
AR_ROOTS = %w[ActiveRecord::Base ApplicationRecord].freeze

Definition = Struct.new(:name, :kind, :files, :superclass, :superclass_nesting, :table_name, :abstract,
                        :table_name_prefix, :items, keyword_init: true)

def literal(node)
  case node
  when Prism::SymbolNode then node.unescaped
  when Prism::StringNode then node.unescaped
  when Prism::TrueNode then true
  when Prism::FalseNode then false
  when Prism::NilNode then nil
  when Prism::IntegerNode then node.value
  when Prism::ArrayNode then node.elements.map { literal(_1) }
  when Prism::ConstantReadNode, Prism::ConstantPathNode then { "constant" => node.slice }
  # `class_name: Foo.name`
  when ->(n) { n.is_a?(Prism::CallNode) && n.name == :name && n.arguments.nil? && n.receiver.is_a?(Prism::ConstantReadNode) }
    node.receiver.slice
  else { "ruby" => node.slice }
  end
end

class Collector < Prism::Visitor
  attr_reader :defs

  def initialize(defs, file)
    @defs = defs
    @file = file
    @owner = []   # Definition stack
    @cref = []    # lexical nesting, as full constant names
    super()
  end

  def visit_class_node(node) = enter(node, :class, node.superclass&.slice)
  def visit_module_node(node) = enter(node, :module, nil)

  # `class << self` bodies only hold class methods; nothing here declares associations.
  def visit_singleton_class_node(node); end

  def visit_def_node(node)
    owner = @owner.last
    if owner && node.receiver.is_a?(Prism::SelfNode) && node.name == :table_name_prefix
      value = node.body.is_a?(Prism::StatementsNode) ? node.body.body.last : node.body
      owner.table_name_prefix = literal(value) if value.is_a?(Prism::StringNode)
      return
    end
    super
  end

  def visit_call_node(node)
    owner = @owner.last
    return super unless owner

    if node.receiver.nil? && MACROS.include?(node.name)
      owner.items << [:association, association(node)]
    elsif node.receiver.nil? && %i[include prepend].include?(node.name)
      node.arguments&.arguments&.each do |arg|
        next unless arg.is_a?(Prism::ConstantReadNode) || arg.is_a?(Prism::ConstantPathNode)
        owner.items << [:include, { "name" => arg.slice, "cref" => @cref.dup }]
      end
    elsif node.receiver.is_a?(Prism::SelfNode) && node.name == :table_name= && node.arguments
      owner.table_name = literal(node.arguments.arguments.first)
    elsif node.receiver.is_a?(Prism::SelfNode) && node.name == :abstract_class= && node.arguments
      owner.abstract = literal(node.arguments.arguments.first) == true
    end
    super
  end

  private
    def enter(node, kind, superclass)
      path = node.constant_path.slice.delete_prefix("::")
      full = @cref.empty? || node.constant_path.slice.start_with?("::") ? path : "#{@cref.last}::#{path}"
      definition = (@defs[full] ||= Definition.new(name: full, kind:, files: [], items: [], abstract: false))
      definition.files << "#{@file}:#{node.location.start_line}" unless definition.files.any? { _1.start_with?("#{@file}:") }
      if superclass
        definition.superclass = superclass
        definition.superclass_nesting = @cref.dup
      end
      @owner.push(definition)
      @cref.push(full)
      node.body&.accept(self)
      @cref.pop
      @owner.pop
    end

    def association(node)
      args = node.arguments&.arguments || []
      name = literal(args.first)
      options = {}
      scope = nil
      args.drop(1).each do |arg|
        case arg
        when Prism::KeywordHashNode, Prism::HashNode
          arg.elements.each do |el|
            next unless el.is_a?(Prism::AssocNode)
            options[literal(el.key).to_s] = literal(el.value)
          end
        when Prism::LambdaNode then scope = arg.slice
        end
      end
      {
        "macro" => node.name.to_s,
        "name" => name,
        "options" => options,
        "scope" => scope,
        "extension" => !node.block.nil?,
        "defined_at" => "#{@file}:#{node.location.start_line}",
      }
    end
end

files = Dir.glob(File.join(ROOT, "{app/models,app/modules}/**/*.rb")).sort
defs = {}
files.each do |path|
  rel = path.delete_prefix("#{ROOT}/")
  Prism.parse_file(path).value.accept(Collector.new(defs, rel))
end

# Ruby lexical lookup: innermost cref first, then top level.
def resolve_constant(defs, name, cref)
  return name.delete_prefix("::") if name.start_with?("::")
  cref.reverse.map { "#{_1}::#{name}" }.find { defs.key?(_1) } || name
end

# ActiveRecord::Inheritance.compute_type: candidates from the owner's own name outward.
def compute_type(known, owner_name, type_name)
  return type_name.delete_prefix("::") if type_name.start_with?("::")
  candidates = []
  owner_name.scan(/::|$/) { candidates.unshift "#{$`}::#{type_name}" }
  candidates << type_name
  candidates.find { known.key?(_1) }
end

def superclass_name(defs, d)
  d.superclass && resolve_constant(defs, d.superclass, d.superclass_nesting || [])
end

def active_record?(defs, name, seen = [])
  return true if AR_ROOTS.include?(name) || EXTERNAL_TABLES.key?(name)
  d = defs[name]
  return false if d.nil? || d.kind != :class || seen.include?(name)
  sup = superclass_name(defs, d)
  sup ? active_record?(defs, sup, seen + [name]) : false
end

models = defs.values.select { _1.kind == :class && !AR_ROOTS.include?(_1.name) && active_record?(defs, _1.name) }.to_h { [_1.name, _1] }
EXTERNAL_TABLES.each do |name, table|
  models[name] ||= Definition.new(name:, kind: :class, files: [], items: [], abstract: false, table_name: table)
end

def abstract?(defs, name) = AR_ROOTS.include?(name) || defs[name]&.abstract

def base_class(defs, d)
  return d.name if EXTERNAL_TABLES.key?(d.name)
  sup = superclass_name(defs, d)
  return d.name if sup.nil? || abstract?(defs, sup) || EXTERNAL_TABLES.key?(sup) || defs[sup].nil?
  base_class(defs, defs[sup])
end

def module_parents(name) = name.split("::")[0...-1].each_index.map { name.split("::")[0.._1].join("::") }.reverse

def table_name(defs, models, d)
  return d.table_name if d.table_name
  sup = superclass_name(defs, d)
  return EXTERNAL_TABLES[sup] if EXTERNAL_TABLES.key?(sup)
  base = base_class(defs, d)
  return table_name(defs, models, defs[base]) if base != d.name
  parents = module_parents(d.name)
  contained = ""
  if (parent = models[parents.first]) && !parent.abstract
    contained = "#{table_name(defs, models, parent).singularize}_"
  end
  prefix_owner = parents.map { defs[_1] }.compact.find { _1.table_name_prefix || models.key?(_1.name) }
  prefix = prefix_owner&.table_name_prefix || ""
  "#{prefix}#{contained}#{d.name.demodulize.underscore.pluralize}"
end

# Walks a body in declaration order, descending into each module the first time it is
# included (as Ruby does). A later association with the same name replaces the earlier one
# but keeps its position, as `_reflections` does.
def expand(defs, d, seen = [], via = nil, out = {})
  d.items.each do |kind, item|
    if kind == :association
      out[item["name"].to_s] = item.merge("via" => via)
    else
      mod = resolve_constant(defs, item["name"], item["cref"])
      next if seen.include?(mod) || defs[mod].nil? || defs[mod].kind != :module
      seen << mod
      expand(defs, defs[mod], seen, mod, out)
    end
  end
  out
end

def derive(defs, models, owner, assoc)
  opts = assoc["options"]
  macro = assoc["macro"]
  name = assoc["name"].to_s
  out = assoc.merge("owner" => owner.name)
  explicit = opts["class_name"]&.to_s
  class_name = explicit || (macro == "has_many" || macro == "has_and_belongs_to_many" ? name.singularize.camelize : name.camelize)
  polymorphic = macro == "belongs_to" && opts["polymorphic"] == true
  out["polymorphic"] = polymorphic
  out["through"] = opts["through"]&.to_s
  out["class_name"] = polymorphic || out["through"] ? explicit : class_name
  out["klass"] = out["class_name"] && compute_type(models, owner.name, out["class_name"])
  out["foreign_key"] =
    if opts["foreign_key"] then opts["foreign_key"].to_s
    elsif out["through"] then nil
    elsif macro == "belongs_to" then "#{name}_id"
    elsif opts["as"] then "#{opts["as"]}_id"
    else owner.name.foreign_key
    end
  out["foreign_type"] = if polymorphic then (opts["foreign_type"] || "#{name}_type").to_s
                        elsif opts["as"] then "#{opts["as"]}_type"
                        end
  out["primary_key"] = opts["primary_key"]&.to_s || "id"
  if macro == "has_and_belongs_to_many"
    out["association_foreign_key"] = (opts["association_foreign_key"] || class_name.foreign_key).to_s
    target = out["klass"] && models[out["klass"]]
    out["join_table"] = opts["join_table"]&.to_s ||
      (target && [table_name(defs, models, owner), table_name(defs, models, target)].sort.join("\0").gsub(/^(.*[_.])(.+)\0\1(.+)/, '\1\2_\3').tr("\0", "_"))
  end
  out
end

result = models.values.sort_by(&:name).map do |d|
  seen = []
  associations = expand(defs, d, seen).values
  sup = superclass_name(defs, d)
  {
    "name" => d.name,
    "external" => EXTERNAL_TABLES.key?(d.name),
    "files" => d.files,
    "superclass" => sup,
    "abstract" => d.abstract,
    "base_class" => d.abstract ? nil : base_class(defs, d),
    "table_name" => d.abstract ? nil : table_name(defs, models, d),
    "includes" => seen,
    "associations" => associations.map { derive(defs, models, d, _1) },
  }
end

# Through associations take their class from the source reflection; resolve after every
# direct association is known. Walks superclasses, as reflect_on_association does.
by_name = result.to_h { [_1["name"], _1] }
find_assoc = lambda do |model_name, assoc_name|
  while (m = by_name[model_name])
    hit = m["associations"].find { _1["name"].to_s == assoc_name.to_s }
    return hit if hit
    model_name = m["superclass"]
  end
end
resolve_through = lambda do |assoc, depth = 0|
  return assoc["klass"] unless assoc["through"]
  return nil if depth > 5
  through = find_assoc.(assoc["owner"], assoc["through"])
  through_klass = through && resolve_through.(through, depth + 1)
  return nil unless through_klass
  source_name = assoc["options"]["source"] || assoc["name"]
  source = find_assoc.(through_klass, source_name) || find_assoc.(through_klass, source_name.to_s.singularize)
  return compute_type(models, assoc["owner"], assoc["options"]["source_type"].to_s) if assoc["options"]["source_type"]
  source && resolve_through.(source, depth + 1)
end
result.each { |m| m["associations"].each { |a| a["klass"] = resolve_through.(a) if a["through"] } }

# AssociationReflection#derive_foreign_key takes the key from `inverse_of` before falling back to the owner name.
result.each do |m|
  m["associations"].each do |a|
    opts = a["options"]
    next if a["macro"] == "belongs_to" || a["through"] || opts["foreign_key"] || opts["as"] || !opts["inverse_of"] || !a["klass"]
    inverse = find_assoc.(a["klass"], opts["inverse_of"])
    a["foreign_key"] = inverse["foreign_key"] if inverse
  end
end

out_path = File.join(ROOT, "nextjs/prisma/relations/associations.json")
File.write(out_path, JSON.pretty_generate({ "generated_by" => "nextjs/scripts/extract-associations.rb", "models" => result }) + "\n")
warn "Wrote #{result.size} models, #{result.sum { _1["associations"].size }} associations to #{out_path.delete_prefix("#{ROOT}/")}"
