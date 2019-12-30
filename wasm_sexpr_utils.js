
// ////////////////////////////////////////////////////////////////////////////
// some tree traversal utilities. these walk s-expressions, and not
// acorn's AST

export function isLocalDecl(decl) {
  return Array.isArray(decl) && decl[0] === 'local';
}

export function* yieldLocalDecls(decls) {
  for (let i = 0; i < decls.length; ++i) {
    const decl = decls[i];
    if (isLocalDecl(decl)) {
      yield decl;
    } else if (Array.isArray(decl)) {
      yield* yieldLocalDecls(decl);
    }
  }
}

export function skipLocalDecls(decls) {
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

export function walkSExpr(sexpr, nodeFun, ancestorList)
{
  // if ancestorList is undefined, this is the top of the walk,
  // so we initialize the list
  if (ancestorList === undefined) {
    ancestorList = [sexpr];
  }

  nodeFun(sexpr, ancestorList);
  if (Array.isArray(sexpr)) {
    sexpr.forEach(node => {
      ancestorList.push(node);
      walkSExpr(node, nodeFun, ancestorList);
      ancestorList.pop();
    });
  }
}

export function nthEquals(n, v)
{
  return function(node) {
    return Array.isArray(node) &&
      node.length > n &&
      node[n] === v;
  };
}

export function headEquals(v)
{
  return nthEquals(0, v);
}

export function and(...conditions)
{
  return function(node) {
    for (let i = 0; i < conditions.length; ++i) {
      if (!conditions[i](node)) {
        return false;
      }
    }
    return true;
  };
}

export function when(condition, then) {
  return function(node) {
    if (condition(node)) {
      then(node);
    }
  };
}

export function matches(node, pattern) {
  if (Array.isArray(node) && Array.isArray(pattern)) {
    for (let i = 0; i < pattern.length; ++i) {
      if (!matches(node[i], pattern[i])) {
        return false;
      }
    }
    return true;
  } else {
    return (pattern === undefined) || (node === pattern);
  }
}

//////////////////////////////////////////////////////////////////////////////

// wasm sexpr builders

export function block(returnType, ...stmts)
{
  return ['block', ['result', returnType], ...stmts];
}
