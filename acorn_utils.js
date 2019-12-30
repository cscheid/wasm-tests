/* walkers, helpers, etc etc for acorn
 */

//////////////////////////////////////////////////////////////////////////////
// stuff to walk acorn asts with. I'm sure acorn has their own APIs,
// but shrug

var childrenDispatch = {
  'AssignmentExpression': p => [p.left, p.right],
  'BinaryExpression': p => [p.left, p.right],
  'BlockStatement': p => p.body,
  'CallExpression': p => [p.callee, ...p.arguments],
  'ConditionalExpression': p => [p.test, p.consequent, p.alternate],
  'DoWhileStatement': p => [p.test, p.body],
  'ExpressionStatement': p => [p.expression],
  'ForStatement': p => [p.init, p.test, p.update, p.body],
  'FunctionDeclaration': p => [...p.params, p.body],
  'Identifier': p => [],
  'IfStatement': p => [p.test, p.consequent, p.alternate],
  'Literal': p => [],
  'ReturnStatement': p => [p.argument],
  'UpdateExpression': p => [p.argument],
  'VariableDeclaration': p => p.declarations,
  'VariableDeclarator': p => [p.id, p.init],
  'WhileStatement': p => [p.test, p.body],
};

export function walkParse(parse, nodeFun, ancestorList)
{
  // if ancestorList is undefined, this is the top of the walk,
  // so we initialize the list
  if (ancestorList === undefined) {
    ancestorList = [parse];
  }
  
  let childrenFn = childrenDispatch[parse.type];
  if (childrenFn === undefined) {
    debugger;
    throw new Error(`Don't know about type ${parse.type}`);
  }
  childrenFn(parse).forEach(child => {
    if (child) {
      ancestorList.push(child);
      nodeFun(child, ancestorList);
      walkParse(child, nodeFun, ancestorList);
      ancestorList.pop();
    }
  });
}

export function setParentNodes(parse)
{
  walkParse(parse, (child, ancestorList) => {
    child.parent = ancestorList[ancestorList.length - 2];
  });
}

// we do this to avoid memory leaks, though I don't know if the GCs
// in javascript have this problem.
export function clearParentNodes(parse)
{
  walkParse(parse, child => delete child.parent);
}

