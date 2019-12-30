import * as acornUtils from './acorn_utils.js';
import * as wu from './wasm_sexpr_utils.js';

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


// ////////////////////////////////////////////////////////////////////////////

// this compiles a single JavaScript function into a "comparable"
// function implemented in WebAssembly.
function compileIntoWasmFunction(f) {
  // we operate on a single function;
  const p = acorn.parse(f.toString()).body[0];

  acornUtils.setParentNodes(p);
  const compiledSExpr = genericEmit(p)[0];
  acornUtils.clearParentNodes(p);

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

// patch branches to specific labels
// note - this mutates the sexprs!!
function patchBranches(sexpr) {
  wu.walkSExpr(
      sexpr, function(node, parents) {
        if (wu.matches(node, ['br', undefined])) {
          const label = node[1];
          let height = 0;
          if (typeof label === 'string') {
            for (let i = parents.length - 1; i >= 0; --i) {
              const parent = parents[i];
              if (wu.matches(parent, ['if']) ||
                wu.matches(parent, ['block']) ||
                wu.matches(parent, ['loop'])) {
                if (parent.label === label) {
                  node[1] = height;
                  return;
                } else {
                  ++height;
                }
              }
            }
            throw new Error(`unmatched label ${label} in block`);
          }
        }
      });
}

// assume for now all functions return values
function emitFunctionDeclaration(parse) {
  const result = ['func', '$' + parse.id.name];
  result.push(...parse.params.map(
      (param) => ['param', '$' + param.name, 'i32']));
  result.push(['result', 'i32']);
  result.push(['local', '$$returnValue', 'i32']);

  const innerBody = ['block', ...genericEmit(parse.body)];

  const bodyDecls = ['block', ['result', 'i32'],
    innerBody,
    ['local.get', '$$returnValue']];

  // tag the block so we can patch our returns
  innerBody.label = 'return-label';

  // //////////////////////////////////////////////////////////////////////////
  // now we take our bad s-exr WebAssembly IR and turn it into a real
  // WASM IR

  patchBranches(bodyDecls);

  // lift all local declarations to the front
  for (const decl of wu.yieldLocalDecls(bodyDecls)) {
    result.push(decl);
  }
  const withoutDecls = wu.skipLocalDecls(bodyDecls);

  result.push(wu.skipLocalDecls(withoutDecls));

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
  const expr = (parse.argument === null) ?
      ['i32.const', 0] :
      genericEmit(parse.argument)[0];
  return [['block',
    ['local.set', '$$returnValue', expr],
    ['br', 'return-label']]];
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

function emitCallExpression(parse) {
  const callee = parse.callee;
  if (callee.type !== 'Identifier') {
    throw new Error('Currently only know how to call ' +
                    'immediate function values');
  }
  const wuArgs = parse.arguments.map((arg) => genericEmit(arg)[0]);
  return [['call', '$' + callee.name, ...wuArgs]];
}
dispatch['CallExpression'] = emitCallExpression;

function emitConditionalExpression(parse) {
  // only support i32 for now..

  const test = parse.test;
  const consequent = parse.consequent;
  const alternate = parse.alternate;

  return [['if', ['result', 'i32'], genericEmit(test)[0],
    ['then', genericEmit(consequent)[0]],
    ['else', genericEmit(alternate)[0]]]];
}
dispatch['ConditionalExpression'] = emitConditionalExpression;

// ////////////////////////////////////////////////////////////////////////////

function testWasmCompilation(f, cases) {
  compileIntoWasmFunction(f)
      .then((wasmF) => {
        cases.forEach((testCase) => {
          const jsResult = f(...testCase);
          const wasmResult = wasmF(...testCase);
          if (wasmResult !== jsResult) {
            throw new Error(`function ${f.name} miscompiled: ` +
                          `test case ${String(testCase)} has mismatched ` +
                          `results ${jsResult} and ${wasmResult}.`);
          }
        });
      });
}

// let's assume that we only operate on i32s for now.
function foo(a, b) {
  const x = a * b;
  return b + x * 3 - a;
}
// testWasmCompilation(foo, [[2, 3]]);

function factorial(n) {
  let result = 1;
  for (let i = 1; i <= n; ++i) {
    result *= i;
  }
  return result;
}
// testWasmCompilation(factorial, [[10]]);

function halfFactorial(n) {
  let result = 1;
  for (let i = 1; i <= n; ++i) {
    if (i % 2 === 1) {
      result *= i;
    }
  }
  return result;
}

// compileIntoWasmFunction(halfFactorial)
//     .then((f) => console.log(halfFactorial(10), f(10)));

function factorial2(n) {
  let result = 1;
  while (n > 1) {
    result = result * n;
    n = n - 1;
  }
  return result;
}

// compileIntoWasmFunction(factorial2)
//     .then((f) => console.log(factorial2(10), f(10)));

function factorial3(n) {
  let result = 1;
  do {
    result *= n;
    n = n - 1;
  } while (n >= 1);
  return result;
}

// compileIntoWasmFunction(factorial3)
//     .then((f) => console.log(factorial3(10), f(10)));

function factorial4(n) {
  if (n < 3) {
    return n;
  } else {
    return n * factorial4(n-1);
  }
}
// testWasmCompilation(factorial4, [[10]]);

function factorial5(n) {
  return (n < 3) ? n : n * factorial5(n-1);
}
testWasmCompilation(factorial5, [[10]]);

// similar pattern to factorial4, but if has a short-circuiting return
function fib(n) {
  if (n <= 1) {
    return n;
  }
  return fib(n-1) + fib(n-2);
}
testWasmCompilation(fib, [[2], [3], [8]]);

// compileIntoWasmFunction(factorial3)
//     .then((f) => console.log(factorial3(10), f(10)));

// ////////////////////////////////////////////////////////////////////////////

// compileFromWatURL("test1.wat")
//   .then(instance => console.log(instance.exports.test()));
