import { parse } from "acorn"
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
  filename: string
): { code: string[]; rejected: string[] } {
  if (!source.includes("loadDataFile")) return { code: [], rejected: [] }
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
        const outer = parents.get(ancestor)?.at(-1)
        if (
          ancestor.type === "FunctionDeclaration" ||
          ancestor.params.length ||
          outer?.type !== "CallExpression" ||
          outer.callee !== ancestor ||
          outer.arguments.length
        ) {
          throw new Error("loader initialization is not in a parameter-free immediate function")
        }
      }
    }
  }
  const code: string[] = []
  const rejected: string[] = []
  for (const candidate of candidates) {
    try {
      const ancestors = parents.get(candidate) ?? []
      assertImmediate(candidate)
      const included = new Set<Located>()
      const names = new Map<string, Located>()
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
            if (!Object.hasOwn(globals, ref.identifier.name))
              throw new Error(`unsupported dependency ${ref.identifier.name}`)
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
          const node = definition.node as Located
          if (node.type !== "VariableDeclarator" && node.type !== "FunctionDeclaration")
            throw new Error(`unsupported declaration ${variable.name}`)
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
      code.push(`(function(){\n${pieces.join("\n")}\n})();`)
    } catch (error) {
      rejected.push(
        `${filename}:${candidate.loc?.start.line ?? 1}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { code, rejected }
}
