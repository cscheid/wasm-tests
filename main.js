/* global WabtModule, acorn */

// ////////////////////////////////////////////////////////////////////////////
// drivers, utilities

const wabt = WabtModule();

// This came from https://webassembly.org/getting-started/js-api/
function instantiate(bytes, imports) {
  return WebAssembly.compile(bytes)
      .then((m) => new WebAssembly.Instance(m, imports));
}

// we use this to test our own knowledge of the webassembly s-expression
// format.
function compileFromWatURL(url, imports, name) {
  return fetch(url)
      .then((response) => response.text())
      .then((text) => wabt
          .parseWat(name || 'unnamed', text)
          .toBinary({}).buffer)
      .then((bytes) => instantiate(bytes, imports));
}

// this compiles a single JavaScript function into a "comparable"
// function implemented in WebAssembly.
function compileIntoWasmFunction(f) {
  // we operate on a single function;
  const p = acorn.parse(f.toString()).body[0];
  const compiledSExpr = genericEmit(p)[0];
  const moduleSExpr = ['module', compiledSExpr,
    ['export', `"${f.name}"`,
      ['func', '$' + f.name]]];
  const moduleText = printSExpr(moduleSExpr);
  console.log(moduleText);
  const binaryWasm = wabt.parseWat(f.name, moduleText).toBinary({}).buffer;
  return instantiate(binaryWasm)
      .then((instance) => instance.exports[f.name]);
}

// /////////////////////////////////////////////////////////////////////////////

/* serializes an sexpr into a String
 */
function printSExpr(sexpr) {
  const result = [];
  function prettyPrintInternal(sexpr) {
    if (Array.isArray(sexpr)) {
      result.push('(');
      sexpr.forEach((el) => prettyPrintInternal(el));
      result.push(')');
    } else {
      result.push(sexpr);
    }
  }
  prettyPrintInternal(sexpr);
  return result.join(' ');
}

// ////////////////////////////////////////////////////////////////////////////
// some tree traversal utilities. these walk s-expressions, and not
// acorn's AST

function isLocalDecl(decl) {
  return Array.isArray(decl) && decl[0] === 'local';
}

function* yieldLocalDecls(decls) {
  for (let i = 0; i < decls.length; ++i) {
    const decl = decls[i];
    if (isLocalDecl(decl)) {
      yield decl;
    } else if (Array.isArray(decl)) {
      yield* yieldLocalDecls(decl);
    }
  }
}

function skipLocalDecls(decls) {
  const result = [];
  for (let i = 0; i < decls.length; ++i) {
    const decl = decls[i];
    if (isLocalDecl(decl)) {
      continue;
    }
    if (Array.isArray(decl)) {
      result.push(skipLocalDecls(decl));
    } else {
      result.push(decl);
    }
  }
  return result;
}

// ////////////////////////////////////////////////////////////////////////////
// just your standard syntax-directed thing, due to webassembly's sweet
// s-expr syntax
// we assume that we only operate on i32s for now.

const dispatch = {};

function genericEmit(parse) {
  if (dispatch[parse.type] === undefined) {
    throw new Error(`Don't know how to compile ${parse.type}, ` +
                    `${parse.start}--${parse.end}`);
  }

  return dispatch[parse.type](parse);
}

function emitFunctionDeclaration(parse) {
  const result = ['func', '$' + parse.id.name];
  result.push(...parse.params.map(
      (param) => ['param', '$' + param.name, 'i32']));
  result.push(['result', 'i32']);

  const bodyDecls = genericEmit(parse.body);

  // lift all local declarations to the front
  for (const decl of yieldLocalDecls(bodyDecls)) {
    result.push(decl);
  }
  const withoutDecls = skipLocalDecls(bodyDecls);

  result.push(...withoutDecls);
  return [result];
}
dispatch['FunctionDeclaration'] = emitFunctionDeclaration;

function emitBlockStatement(parse) {
  const result = [];
  parse.body.forEach((p) => {
    result.push(...genericEmit(p));
  });
  return result;
}
dispatch['BlockStatement'] = emitBlockStatement;

function emitVariableDeclaration(parse) {
  const result = [];
  if (parse.kind !== 'let' &&
      parse.kind !== 'const') {
    throw new Error('we only support let and const declarations for now.');
  }
  if (parse.declarations.length !== 1) {
    throw new Error(
        'we only support single-variable declarations for now.');
  }
  const declarator = parse.declarations[0];
  const localName = '$' + declarator.id.name;
  // again we assume i32 only for now.
  result.push(['local', localName, 'i32']);
  if (declarator.init) {
    result.push(['local.set', localName, genericEmit(declarator.init)[0]]);
  }
  return result;
}
dispatch['VariableDeclaration'] = emitVariableDeclaration;

const binaryOperatorToWasmOp = {
  '*': 'i32.mul',
  '-': 'i32.sub',
  '+': 'i32.add',
  '/': 'i32.div_s',
  '%': 'i32.rem_s',
  '<=': 'i32.le_s',
  '<': 'i32.lt_s',
  '>=': 'i32.ge_s',
  '>': 'i32.gt_s',
  '===': 'i32.eq',
  '!==': 'i32.ne',
  '&': 'i32.and',
  '|': 'i32.or',
  '^': 'i32.xor',
  '>>': 'i32.shr_s',
  '<<': 'i32.shl_s',
};

function emitBinaryExpression(parse) {
  const result = [];
  const binOp = binaryOperatorToWasmOp[parse.operator];
  if (binOp === undefined) {
    throw new Error(`Unrecognized operator '${parse.operator}'`);
  }
  result.push(binOp);
  const left = genericEmit(parse.left);
  const right = genericEmit(parse.right);
  if (left.length !== 1) {
    throw new Error(`Expected left expression to emit 1 statement, ` +
                        `but it emitted ${left.length} instead.`);
  }
  if (right.length !== 1) {
    throw new Error(`Expected right expression to emit 1 statement, ` +
                        `but it emitted ${right.length} instead.`);
  }
  result.push(left[0]);
  result.push(right[0]);
  return [result];
}
dispatch['BinaryExpression'] = emitBinaryExpression;

// for now, all identifiers in generic emit position are
// emitted as local variable lookups. This is very obviously going
// to be wrong in general.
function emitIdentifier(parse) {
  return [['local.get', '$' + parse.name]];
}
dispatch['Identifier'] = emitIdentifier;

function emitReturnStatement(parse) {
  return genericEmit(parse.argument);
}
dispatch['ReturnStatement'] = emitReturnStatement;

function emitLiteral(parse) {
  // no validation for now.
  return [['i32.const', parse.raw]];
}
dispatch['Literal'] = emitLiteral;

// /////////////////////////////////////////////////////////////////////////////
// structured programming

function emitForStatement(parse) {
  const initializer = genericEmit(parse.init);
  const test = genericEmit(parse.test)[0];
  const update = genericEmit(parse.update)[0];
  const body = genericEmit(parse.body);

  const result = ['block',
    ...initializer,
    ['loop',
      ['if', test,
        ['then',
          ...body,
          ['drop', update],
          ['br', 1]],
        ['else',
          ['br', 2]]]]];
  return [result];
}

dispatch['ForStatement'] = emitForStatement;

function emitIfStatement(parse) {
  const test = genericEmit(parse.test)[0];
  const then = genericEmit(parse.consequent);

  const result = ['if', test,
    ['then', ...then]];
  if (parse.alternate) {
    const elseBlock = genericEmit(parse.alternate);
    result.push(['else', ...elseBlock]);
  }
  return [result];
}
dispatch['IfStatement'] = emitIfStatement;

function emitWhileStatement(parse) {
  const test = genericEmit(parse.test)[0];
  const body = genericEmit(parse.body);

  const result = ['block',
    ['loop',
      ['if', ['i32.eqz', test],
        ['then', ['br', 2]]],
      ...body,
      ['br', 0]]];
  return [result];
}
dispatch['WhileStatement'] = emitWhileStatement;

function emitDoWhileStatement(parse) {
  const test = genericEmit(parse.test)[0];
  const body = genericEmit(parse.body);

  const result = ['block',
    ['loop',
      ...body,
      ['if', ['i32.eqz', test],
        ['then', ['br', 2]]],
      ['br', 0]]];
  return [result];
}
dispatch['DoWhileStatement'] = emitDoWhileStatement;

// ////////////////////////////////////////////////////////////////////////////

// Everything is easy here, since all of our lvalues are identifiers
// for now.

function emitAssignmentExpression(parse) {
  const left = parse.left;
  const name = '$' + left.name;
  const right = genericEmit(parse.right)[0];
  const result = ['block', ['result', 'i32']];
  if (parse.operator === '=') {
    if (left.type !== 'Identifier') {
      throw new Error('Currently only know how to parse ' +
                      'AssignmentExpression with identifier lvalues');
    }
    result.push(['local.set', name, right]);
  } else {
    const op = binaryOperatorToWasmOp[parse.operator.slice(0, -1)];

    if (op === undefined) {
      throw new Error(`Don't know what to do with ${parse.operator}`);
    }

    if (left.type !== 'Identifier') {
      throw new Error('Currently only know how to parse ' +
                      'AssignmentExpression with identifier lvalues');
    }

    result.push(['local.set', name, [op, ['local.get', name], right]]);
  }
  result.push(['local.get', name]);
  return [result];
}

dispatch['AssignmentExpression'] = emitAssignmentExpression;

function emitUpdateExpression(parse) {
  const result = ['block', ['result', 'i32']];

  if (parse.operator === '++') {
    const argument = parse.argument;
    if (argument.type !== 'Identifier') {
      throw new Error('Currently only know how to parse ' +
                      'AssignmentExpression with identifier lvalues');
    }
    const name = '$' + argument.name;
    const inc = ['local.set', name,
      ['i32.add', ['local.get', name], ['i32.const', 1]]];
    if (parse.prefix) {
      result.push(inc, ['local.get', name]);
    } else {
      result.push(['local.get', name], inc);
    }
  } else if (parse.operator === '--') {
    const argument = parse.argument;
    if (argument.type !== 'Identifier') {
      throw new Error('Currently only know how to parse ' +
                      'AssignmentExpression with identifier lvalues');
    }
    const name = '$' + argument.name;
    const dec = ['local.set', name,
      ['i32.sub', ['local.get', name], ['i32.const', 1]]];
    if (parse.prefix) {
      result.push(dec, ['local.get', name]);
    } else {
      result.push(['local.get', name], dec);
    }
  } else {
    throw new Error('Currently only know about update expressions -- and ++');
  }

  return [result];
}

dispatch['UpdateExpression'] = emitUpdateExpression;

function emitExpressionStatement(parse) {
  const result = ['drop', genericEmit(parse.expression)[0]];
  return [result];
}

dispatch['ExpressionStatement'] = emitExpressionStatement;

// ////////////////////////////////////////////////////////////////////////////

// let's assume that we only operate on i32s for now.
function foo(a, b) {
  const x = a * b;
  return b + x * 3 - a;
}

compileIntoWasmFunction(foo)
    .then((f) => console.log(foo(2, 3), f(2, 3)));

function factorial(n) {
  let result = 1;
  for (let i = 1; i <= n; ++i) {
    result *= i;
  }
  return result;
}

compileIntoWasmFunction(factorial)
    .then((f) => console.log(factorial(10), f(10)));

function halfFactorial(n) {
  let result = 1;
  for (let i = 1; i <= n; ++i) {
    if (i % 2 === 1) {
      result *= i;
    }
  }
  return result;
}

compileIntoWasmFunction(halfFactorial)
    .then((f) => console.log(halfFactorial(10), f(10)));

function factorial2(n) {
  let result = 1;
  while (n > 1) {
    result = result * n;
    n = n - 1;
  }
  return result;
}

compileIntoWasmFunction(factorial2)
    .then((f) => console.log(factorial2(10), f(10)));

function factorial3(n) {
  let result = 1;
  do {
    result *= n;
    n = n - 1;
  } while (n >= 1);
  return result;
}

compileIntoWasmFunction(factorial3)
    .then((f) => console.log(factorial3(10), f(10)));
