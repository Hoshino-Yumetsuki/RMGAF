import { parse } from "acorn"
import { createContext, Script } from "node:vm"
import { fullAncestor } from "acorn-walk"
import { analyze, type Variable } from "eslint-scope"
import type { Node, Program } from "estree"

// Only a data loader's lexical dependency closure is executed. Rendering and
// unrelated plugin hooks are deliberately outside this execution surface.
const globals: Record<string, true | undefined> = {
  DataManager: true,
  PluginManager: true,
  XMLHttpRequest: true,
  window: true,
  globalThis: true,
  console: true,
  JSON: true,
  Object: true,
  Array: true,
  String: true,
  Number: true,
  Boolean: true,
  Math: true,
  Date: true,
  RegExp: true,
  Error: true,
  TypeError: true,
  RangeError: true,
  SyntaxError: true,
  URIError: true,
  Map: true,
  Set: true,
  WeakMap: true,
  WeakSet: true,
  ArrayBuffer: true,
  DataView: true,
  Uint8Array: true,
  Uint16Array: true,
  Uint32Array: true,
  Int8Array: true,
  Int16Array: true,
  Int32Array: true,
  Float32Array: true,
  Float64Array: true,
  TextDecoder: true,
  TextEncoder: true,
  atob: true,
  btoa: true,
  decodeURIComponent: true,
  encodeURIComponent: true,
  decodeURI: true,
  encodeURI: true,
  escape: true,
  unescape: true,
  parseInt: true,
  parseFloat: true,
  isNaN: true,
  isFinite: true,
  Infinity: true,
  NaN: true,
  undefined: true,
  Promise: true
}

type Located = Node & { start: number; end: number }

export function extractLoaders(
  source: string,
  filename: string,
  deferGlobals = false
): { code: string[]; rejected: string[]; dependencies: string[] } {
  if (!source.includes("loadDataFile")) return { code: [], rejected: [], dependencies: [] }
  const tree = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    ranges: true,
    locations: true
  })
  const parents = new Map<Located, Located[]>()
  const memberNames = new Map<Located, string>()
  const candidates: Located[] = []
  fullAncestor(tree, (raw, _state, ancestors) => {
    const node = raw as unknown as Located
    parents.set(node, ancestors.slice(0, -1) as unknown as Located[])
    if (node.type === "MemberExpression") {
      const name =
        !node.computed && node.property.type === "Identifier"
          ? node.property.name
          : node.computed &&
              node.property.type === "Literal" &&
              typeof node.property.value === "string"
            ? node.property.value
            : undefined
      if (name !== undefined) memberNames.set(node, name)
    }
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression"
    )
      return
    const member = node.left
    const property = memberNames.get(member as Located)
    if (
      member.object.type === "Identifier" &&
      member.object.name === "DataManager" &&
      property === "loadDataFile"
    )
      candidates.push(node)
  })
  const scopes = analyze(tree as unknown as Program, {
    ecmaVersion: 2022,
    sourceType: "script",
    optimistic: true,
    ignoreEval: true
  })
  const references = scopes.scopes.flatMap((scope) => scope.references)
  const memberAccess = (identifier: Located) => {
    const chain = parents.get(identifier) ?? []
    const member = chain.at(-1)
    if (member?.type !== "MemberExpression" || member.object !== identifier) return
    const property = memberNames.get(member)
    if (property === undefined) return
    let node = member
    let index = chain.length - 2
    while (true) {
      const ancestor = chain[index]
      if (ancestor?.type !== "MemberExpression" || ancestor.object !== node) break
      node = ancestor
      index--
    }
    return { property, member, node, parent: chain[index] }
  }
  const globalParameters = (node: Located): string[] | undefined => {
    const outer = parents.get(node)?.at(-1)
    if (
      (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression") ||
      outer?.type !== "CallExpression" ||
      outer.callee !== node ||
      outer.arguments.length !== node.params.length
    )
      return
    const names: string[] = []
    for (let i = 0; i < node.params.length; i++) {
      const param = node.params[i]!
      const argument = outer.arguments[i]!
      if (param.type !== "Identifier" || argument.type !== "ThisExpression") return
      names.push(param.name)
    }
    return names
  }
  const assertImmediate = (node: Located) => {
    for (const ancestor of parents.get(node) ?? []) {
      if (
        [
          "IfStatement",
          "SwitchStatement",
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
          "WhileStatement",
          "DoWhileStatement",
          "TryStatement",
          "ConditionalExpression",
          "LogicalExpression"
        ].includes(ancestor.type)
      ) {
        throw new Error("conditional loader initialization is unsupported")
      }
      if (
        ancestor.type === "FunctionDeclaration" ||
        ancestor.type === "FunctionExpression" ||
        ancestor.type === "ArrowFunctionExpression"
      ) {
        if (!globalParameters(ancestor)) {
          throw new Error(
            "loader initialization is not in an immediate function with global-only arguments"
          )
        }
      }
    }
  }
  const immutableTable = (variable: Variable): boolean => {
    const definition = variable.defs[0]?.node
    if (definition?.type !== "VariableDeclarator" || definition.init?.type !== "ObjectExpression")
      return false
    const properties = new Set<string>()
    for (const property of definition.init.properties) {
      if (property.type !== "Property" || property.computed || property.kind !== "init")
        return false
      const name =
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.type === "Literal"
            ? String(property.key.value)
            : undefined
      if (name === undefined) return false
      properties.add(name)
      if (property.value.type === "Literal") continue
      if (
        property.value.type !== "FunctionExpression" ||
        property.value.body.body.length !== 1 ||
        property.value.body.body[0]?.type !== "ReturnStatement"
      )
        return false
      const fn = property.value as Located
      if (
        references.some((ref) => {
          const id = ref.identifier as Located
          return (
            id.start >= fn.start && id.end <= fn.end && ref.resolved?.scope.block !== property.value
          )
        })
      )
        return false
    }
    return variable.references.every((ref) => {
      if (ref.isWrite()) return ref.init
      const access = memberAccess(ref.identifier as Located)
      if (!access || !properties.has(access.property)) return false
      const use = access.parent
      return !(
        (use?.type === "AssignmentExpression" && use.left === access.node) ||
        use?.type === "UpdateExpression" ||
        (use?.type === "UnaryExpression" && use.operator === "delete")
      )
    })
  }
  const code: string[] = []
  const rejected: string[] = []
  const dependencies = new Set<string>()
  for (const candidate of candidates) {
    try {
      const ancestors = parents.get(candidate) ?? []
      assertImmediate(candidate)
      const included = new Set<Located>()
      const names = new Map<string, Located>()
      const bindings = new Set<string>()
      const missing = new Set<string>()
      const immutable = new Set<Variable>()
      const pending = [candidate]
      const fields = new Map<Variable, Map<string, Located | null>>()
      const wholeValues = new Set<Variable>()
      while (pending.length) {
        const current = pending.pop()!
        if (included.has(current)) continue
        included.add(current)
        for (const ref of references) {
          const identifier = ref.identifier as Located
          if (identifier.start < current.start || identifier.end > current.end) continue
          const variable = ref.resolved
          const scope = variable?.scope.block as Located | undefined
          if (
            variable?.name === "arguments" &&
            !variable.defs.length &&
            variable.scope.type === "function" &&
            scope &&
            scope.start >= current.start &&
            scope.end <= current.end
          )
            continue
          if (!variable || !variable.defs.length) {
            if (!Object.hasOwn(globals, ref.identifier.name)) {
              if (!deferGlobals || ref.identifier.name === "arguments")
                throw new Error(`unsupported dependency ${ref.identifier.name}`)
              missing.add(ref.identifier.name)
            }
            continue
          }
          if (
            variable.defs.every((definition) => {
              const node = definition.node as Located
              return node.start >= current.start && node.end <= current.end
            })
          )
            continue
          if (variable.defs.length !== 1)
            throw new Error(`multiple definitions for ${variable.name}`)
          const definition = variable.defs[0]
          if (definition.type === "Parameter") {
            const owner = definition.node as Located
            if (!ancestors.includes(owner) || !globalParameters(owner)?.includes(variable.name))
              throw new Error(`unsupported parameter dependency ${variable.name}`)
            if (variable.references.some((usage) => usage.isWrite()))
              throw new Error(`mutable external dependency ${variable.name}`)
            bindings.add(variable.name)
            continue
          }
          const node = definition.node as Located
          if (node.type !== "VariableDeclarator" && node.type !== "FunctionDeclaration")
            throw new Error(`unsupported declaration ${variable.name}`)
          if (immutableTable(variable)) immutable.add(variable)
          if (node.type === "VariableDeclarator" && (node.id.type !== "Identifier" || !node.init))
            throw new Error(`uninitialized/destructured dependency ${variable.name}`)
          const previous = names.get(variable.name)
          if (previous && previous !== node) throw new Error(`shadowed dependency ${variable.name}`)
          names.set(variable.name, node)
          for (const write of variable.references) {
            const location = write.identifier as Located
            if (write.isWrite() && (location.start < node.start || location.end > node.end))
              throw new Error(`mutable external dependency ${variable.name}`)
          }
          const access = memberAccess(identifier)
          if (!access) wholeValues.add(variable)
          else {
            let requested = fields.get(variable)
            if (!requested) fields.set(variable, (requested = new Map()))
            if (!requested.has(access.property)) {
              let initialization: Located | null = null
              for (const usage of variable.references) {
                const field = memberAccess(usage.identifier as Located)
                if (!field || field.property !== access.property) continue
                const assignment = field.parent
                if (assignment?.type !== "AssignmentExpression" || assignment.left !== field.node)
                  continue
                if (
                  assignment.left !== field.member ||
                  assignment.operator !== "=" ||
                  initialization ||
                  assignment.right.type !== "Literal" ||
                  (assignment.right.value !== null &&
                    !["string", "number", "boolean"].includes(typeof assignment.right.value)) ||
                  parents.get(assignment)?.at(-1)?.type !== "ExpressionStatement"
                ) {
                  throw new Error(
                    `unsupported static initialization ${variable.name}.${access.property}`
                  )
                }
                assertImmediate(assignment)
                initialization = assignment
              }
              requested.set(access.property, initialization)
              if (initialization) pending.push(initialization)
            }
          }
          pending.push(node)
        }
      }
      // Flattening is safe only when no intervening executable statements use
      // these dependencies. Do not silently omit setup such as key.push(...).
      for (const ref of references) {
        const id = ref.identifier as Located
        if (
          !ref.resolved ||
          !names.has(ref.resolved.name) ||
          [...included].some((node) => id.start >= node.start && id.end <= node.end)
        )
          continue
        if (immutable.has(ref.resolved)) continue
        const chain = parents.get(id) ?? []
        if (
          chain.some(
            (node) =>
              ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
                node.type
              ) && !ancestors.includes(node)
          )
        )
          continue
        const access = memberAccess(id)
        const requested = fields.get(ref.resolved)
        if (
          access &&
          requested &&
          [...requested.values()].some(Boolean) &&
          !wholeValues.has(ref.resolved)
        ) {
          const use = access.parent
          const call =
            (use?.type === "CallExpression" || use?.type === "NewExpression") &&
            use.callee === access.node
          const write =
            (use?.type === "AssignmentExpression" && use.left === access.node) ||
            use?.type === "UpdateExpression" ||
            (use?.type === "UnaryExpression" && use.operator === "delete")
          if (!call && (!write || !requested.has(access.property))) continue
        }
        throw new Error(
          `dependency ${ref.resolved.name} has additional initialization/use outside loader closure`
        )
      }
      const pieces = [...included]
        .sort((a, b) => a.start - b.start)
        .map((node) => {
          if (node.type === "VariableDeclarator") {
            const declaration = parents.get(node)?.at(-1)
            if (declaration?.type !== "VariableDeclaration")
              throw new Error("invalid variable declaration")
            return `${declaration.kind} ${source.slice(node.start, node.end)};`
          }
          return source.slice(node.start, node.end) + ";"
        })
      code.push(
        `(function(){\n${[...bindings].map((name) => `const ${name} = globalThis;`).join("\n")}\n${pieces.join("\n")}\n})();`
      )
      for (const name of missing) dependencies.add(name)
    } catch (error) {
      rejected.push(
        `${filename}:${candidate.loc?.start.line ?? 1}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { code, rejected, dependencies: [...dependencies] }
}

/** Resolve computed loader names in the worker, without running plugin startup. */
export function normalizeLoader(source: string): string {
  const tree = parse(source, { ecmaVersion: "latest", ranges: true })
  const decoders = new Set<string>()
  fullAncestor(tree, (node) => {
    if (node.type !== "AssignmentExpression" || node.left.type !== "MemberExpression") return
    const member = node.left
    if (
      member.object.type !== "Identifier" ||
      member.object.name !== "DataManager" ||
      !member.computed
    )
      return
    if (
      member.property.type === "CallExpression" &&
      member.property.callee.type === "Identifier" &&
      member.property.arguments.every((arg) => arg.type === "Literal")
    )
      decoders.add(member.property.callee.name)
  })
  if (!decoders.size) return source
  const definitions = tree.body.filter(
    (node) => node.type === "FunctionDeclaration" && node.id && decoders.has(node.id.name)
  )
  if (!definitions.length) return source
  const end = Math.max(...definitions.map((node) => node.end))
  const context = createContext({ atob, btoa }, { codeGeneration: { strings: false, wasm: false } })
  // No engine, timers, DOM, filesystem or network is supplied to the string-table prelude.
  new Script(source.slice(0, end)).runInContext(context, { timeout: 2000 })
  const calls: { start: number; end: number }[] = []
  const scopes = analyze(tree as unknown as Program, {
    ecmaVersion: 2022,
    sourceType: "script",
    optimistic: true,
    ignoreEval: true
  })
  const globalCalls = new Set(
    scopes.scopes
      .flatMap((scope) => scope.references)
      .filter((ref) => ref.resolved?.scope.type === "global" && decoders.has(ref.identifier.name))
      .map((ref) => (ref.identifier as Located).start)
  )
  fullAncestor(tree, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      globalCalls.has(node.callee.start) &&
      node.arguments.every((arg) => arg.type === "Literal")
    )
      calls.push(node)
  })
  const values: unknown = new Script(
    `JSON.stringify([${calls.map((node) => source.slice(node.start, node.end)).join(",")}])`
  ).runInContext(context, { timeout: 2000 })
  if (typeof values !== "string") throw new Error("String-table decoder returned no values")
  const decoded = JSON.parse(values) as unknown[]
  for (let i = calls.length - 1; i >= 0; i--) {
    if (typeof decoded[i] !== "string") continue
    const node = calls[i]!
    source = source.slice(0, node.start) + JSON.stringify(decoded[i]) + source.slice(node.end)
  }
  return source
}

/** Select a standalone global library declaration, not the rest of its script. */
export function extractLibrary(source: string, name: string): string | undefined {
  if (!source.includes(name)) return
  const tree = parse(source, { ecmaVersion: "latest", ranges: true })
  for (const statement of tree.body) {
    if (statement.type === "VariableDeclaration") {
      const declaration = statement.declarations.find(
        (node) => node.id.type === "Identifier" && node.id.name === name && node.init
      )
      if (declaration)
        return `${statement.kind} ${source.slice(declaration.start, declaration.end)};`
    }
    if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression")
      continue
    const call = statement.expression
    if (
      call.callee.type !== "FunctionExpression" ||
      call.arguments[0]?.type !== "ThisExpression" ||
      call.callee.params[0]?.type !== "Identifier"
    )
      continue
    const root = call.callee.params[0].name
    let exportsName = false
    fullAncestor(call.callee.body, (node) => {
      if (node.type !== "AssignmentExpression" || node.left.type !== "MemberExpression") return
      const member = node.left
      if (
        member.object.type === "Identifier" &&
        member.object.name === root &&
        ((!member.computed &&
          member.property.type === "Identifier" &&
          member.property.name === name) ||
          (member.computed && member.property.type === "Literal" && member.property.value === name))
      )
        exportsName = true
    })
    if (exportsName) return source.slice(statement.start, statement.end)
  }
}
