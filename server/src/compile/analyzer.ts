// https://www.angelcode.com/angelscript/sdk/docs/manual/doc_expressions.html

import {
    DeclaredEnumMember,
    funcHeadDestructor,
    getNextTokenIfExist,
    getNodeLocation, isFunctionHeadReturns,
    NodeArgList,
    NodeAssign,
    NodeCASE,
    NodeClass,
    NodeCondition,
    NodeDoWhile, NodeEnum,
    NodeExpr,
    NodeExprPostOp,
    NodeExprPostOp1,
    NodeExprStat,
    NodeExprTerm,
    NodeExprTerm2,
    NodeExprValue,
    NodeFor,
    NodeFunc,
    NodeFuncCall,
    NodeIf,
    NodeLiteral,
    NodeName,
    NodeNamespace,
    NodeParamList,
    NodeReturn,
    NodeScope,
    NodeScript,
    NodeStatBlock,
    NodeStatement,
    NodeSwitch,
    NodeType,
    NodeVar,
    NodeVarAccess,
    NodeWhile
} from "./nodes";
import {
    AnalyzedScope,
    builtinBoolType,
    builtinNumberType,
    copySymbolsInScope,
    createSymbolScope,
    DeducedType,
    findClassScopeWithParent,
    findGlobalScope,
    findNamespaceScope, findScopeByIdentifier,
    findSymbolicFunctionWithParent,
    findSymbolicTypeWithParent,
    findSymbolicVariableWithParent, insertSymbolicObject,
    PrimitiveType,
    SymbolicFunction,
    SymbolicType,
    SymbolicVariable,
    SymbolKind,
    SymbolScope
} from "./symbolic";
import {diagnostic} from "../code/diagnostic";
import {Range} from "vscode-languageserver";
import {TokenKind} from "./token";

type AnalyzeQueue = {
    classQueue: { scope: SymbolScope, node: NodeClass }[],
    funcQueue: { scope: SymbolScope, node: NodeFunc }[],
};

// SCRIPT        ::= {IMPORT | ENUM | TYPEDEF | CLASS | MIXIN | INTERFACE | FUNCDEF | VIRTPROP | VAR | FUNC | NAMESPACE | ';'}
function forwardScript(parentScope: SymbolScope, ast: NodeScript, queue: AnalyzeQueue) {
    // 宣言分析
    for (const statement of ast) {
        const nodeName = statement.nodeName;
        if (nodeName === NodeName.Enum) {
            forwardEnum(parentScope, statement);
        } else if (nodeName === NodeName.Class) {
            forwardClass(parentScope, statement, queue);
        } else if (nodeName === NodeName.Func) {
            forwardFunc(parentScope, statement, queue);
        } else if (nodeName === NodeName.Namespace) {
            forwardNamespace(parentScope, statement, queue);
        }
    }
}

function analyzeScript(queue: AnalyzeQueue, scriptScope: SymbolScope, ast: NodeScript) {
    // 実装分析
    for (const func of queue.funcQueue) {
        analyzeFunc(func.scope, func.node);
    }
}

// NAMESPACE     ::= 'namespace' IDENTIFIER {'::' IDENTIFIER} '{' SCRIPT '}'
function forwardNamespace(parentScope: SymbolScope, namespace_: NodeNamespace, queue: AnalyzeQueue) {
    if (namespace_.namespaceList.length === 0) return;

    let scopeIterator = parentScope;
    for (let i = 0; i < namespace_.namespaceList.length; i++) {
        const nextNamespace = namespace_.namespaceList[i];
        const existing = findNamespaceScope(parentScope, nextNamespace.text);
        if (existing === undefined) {
            const newScope: SymbolScope = createSymbolScope(nextNamespace.text, parentScope);
            scopeIterator.childScopes.push(newScope);
            scopeIterator = newScope;
        } else {
            scopeIterator = existing;
        }
    }

    forwardScript(scopeIterator, namespace_.script, queue);
}

// ENUM          ::= {'shared' | 'external'} 'enum' IDENTIFIER (';' | ('{' IDENTIFIER ['=' EXPR] {',' IDENTIFIER ['=' EXPR]} '}'))
function forwardEnum(parentScope: SymbolScope, nodeEnum: NodeEnum) {
    const symbol: SymbolicType = {
        symbolKind: SymbolKind.Type,
        declaredPlace: nodeEnum.identifier,
        sourceNode: nodeEnum,
    };

    const scope: SymbolScope = createSymbolScope(nodeEnum, parentScope);
    parentScope.childScopes.push(scope);
    insertSymbolicObject(parentScope.symbolDict, symbol);
    forwardEnumMembers(scope, nodeEnum.memberList);
}

function forwardEnumMembers(parentScope: SymbolScope, memberList: DeclaredEnumMember[]) {
    for (const member of memberList) {
        const symbol: SymbolicVariable = {
            symbolKind: SymbolKind.Variable,
            declaredPlace: member.identifier,
            type: builtinNumberType,
        };
        insertSymbolicObject(parentScope.symbolDict, symbol);
    }
}

// CLASS         ::= {'shared' | 'abstract' | 'final' | 'external'} 'class' IDENTIFIER (';' | ([':' IDENTIFIER {',' IDENTIFIER}] '{' {VIRTPROP | FUNC | VAR | FUNCDEF} '}'))
function forwardClass(parentScope: SymbolScope, nodeClass: NodeClass, queue: AnalyzeQueue) {
    const symbol: SymbolicType = {
        symbolKind: SymbolKind.Type,
        declaredPlace: nodeClass.identifier,
        sourceNode: nodeClass,
    };
    const scope: SymbolScope = createSymbolScope(nodeClass, parentScope);
    parentScope.childScopes.push(scope);
    insertSymbolicObject(parentScope.symbolDict, symbol);
    queue.classQueue.push({scope, node: nodeClass});

    for (const member of nodeClass.memberList) {
        if (member.nodeName === NodeName.VirtualProp) {
            // TODO
        } else if (member.nodeName === NodeName.Func) {
            forwardFunc(scope, member, queue);
        } else if (member.nodeName === NodeName.Var) {
            // TODO
        }
    }
}

// TYPEDEF       ::= 'typedef' PRIMTYPE IDENTIFIER ';'

// FUNC          ::= {'shared' | 'external'} ['private' | 'protected'] [((TYPE ['&']) | '~')] IDENTIFIER PARAMLIST ['const'] FUNCATTR (';' | STATBLOCK)
function forwardFunc(parentScope: SymbolScope, func: NodeFunc, queue: AnalyzeQueue) {
    if (func.head === funcHeadDestructor) return;
    const symbol: SymbolicFunction = {
        symbolKind: SymbolKind.Function,
        declaredPlace: func.identifier,
        sourceNode: func,
        overloadedAlt: undefined,
    };
    const scope: SymbolScope = createSymbolScope(func, parentScope);

    parentScope.childScopes.push(scope);
    insertSymbolicObject(parentScope.symbolDict, symbol);
    queue.funcQueue.push({scope, node: func});
}

function analyzeFunc(scope: SymbolScope, ast: NodeFunc) {
    if (ast.head === funcHeadDestructor) {
        analyzeStatBlock(scope, ast.statBlock);
        return;
    }

    // 引数をスコープに追加
    analyzeParamList(scope, ast.paramList);

    // スコープ分析
    analyzeStatBlock(scope, ast.statBlock);
}

// INTERFACE     ::= {'external' | 'shared'} 'interface' IDENTIFIER (';' | ([':' IDENTIFIER {',' IDENTIFIER}] '{' {VIRTPROP | INTFMTHD} '}'))

// VAR           ::= ['private'|'protected'] TYPE IDENTIFIER [( '=' (INITLIST | EXPR)) | ARGLIST] {',' IDENTIFIER [( '=' (INITLIST | EXPR)) | ARGLIST]} ';'
function analyzeVar(scope: SymbolScope, nodeVar: NodeVar) {
    const type = analyzeType(scope, nodeVar.type);
    for (const declaredVar of nodeVar.variables) {
        const initializer = declaredVar.initializer;
        if (initializer !== undefined) {
            if (initializer.nodeName === NodeName.Expr) analyzeExpr(scope, initializer);
            if (initializer.nodeName === NodeName.ArgList) analyzeArgList(scope, initializer);
        }
        const variable: SymbolicVariable = {
            symbolKind: SymbolKind.Variable,
            type: type?.symbol,
            declaredPlace: declaredVar.identifier,
        };
        insertSymbolicObject(scope.symbolDict, variable);
    }
}

// IMPORT        ::= 'import' TYPE ['&'] IDENTIFIER PARAMLIST FUNCATTR 'from' STRING ';'
// FUNCDEF       ::= {'external' | 'shared'} 'funcdef' TYPE ['&'] IDENTIFIER PARAMLIST ';'
// VIRTPROP      ::= ['private' | 'protected'] TYPE ['&'] IDENTIFIER '{' {('get' | 'set') ['const'] FUNCATTR (STATBLOCK | ';')} '}'
// MIXIN         ::= 'mixin' CLASS
// INTFMTHD      ::= TYPE ['&'] IDENTIFIER PARAMLIST ['const'] ';'

// STATBLOCK     ::= '{' {VAR | STATEMENT} '}'
function analyzeStatBlock(scope: SymbolScope, ast: NodeStatBlock) {
    for (const statement of ast.statements) {
        if (statement.nodeName === NodeName.Var) {
            analyzeVar(scope, statement);
        } else {
            analyzeStatement(scope, statement as NodeStatement);
        }
    }
}

// PARAMLIST     ::= '(' ['void' | (TYPE TYPEMOD [IDENTIFIER] ['=' EXPR] {',' TYPE TYPEMOD [IDENTIFIER] ['=' EXPR]})] ')'
function analyzeParamList(scope: SymbolScope, ast: NodeParamList) {
    for (const param of ast) {
        if (param.identifier === undefined) continue;

        const type = analyzeType(scope, param.type);

        insertSymbolicObject(scope.symbolDict, {
            symbolKind: SymbolKind.Variable,
            type: type?.symbol,
            declaredPlace: param.identifier,
        });
    }
}

// TYPEMOD       ::= ['&' ['in' | 'out' | 'inout']]

// TYPE          ::= ['const'] SCOPE DATATYPE ['<' TYPE {',' TYPE} '>'] { ('[' ']') | ('@' ['const']) }
function analyzeType(scope: SymbolScope, ast: NodeType): DeducedType | undefined {
    if (ast.scope !== undefined) analyzeScope(scope, ast.scope);
    const found = findSymbolicTypeWithParent(scope, ast.datatype.identifier);
    if (found !== undefined) {
        scope.referencedList.push({
            declaredSymbol: found,
            referencedToken: ast.datatype.identifier
        });
        return {symbol: found};
    }
    diagnostic.addError(ast.datatype.identifier.location, `Undefined type: ${ast.datatype.identifier.text}`);
}

function isTypeMatch(src: DeducedType, dest: DeducedType) {
    const srcType = src.symbol;
    const destType = dest.symbol;
    const srcNode = srcType.sourceNode;
    if (srcNode === PrimitiveType.Void) {
        return false;
    }
    if (srcNode === PrimitiveType.Number) {
        return destType.sourceNode === PrimitiveType.Number;
    }
    if (srcNode === PrimitiveType.Bool) {
        return destType.sourceNode === PrimitiveType.Bool;
    }
    // TODO : 継承などに対応
    if (srcNode.nodeName === NodeName.Class) {
        if (typeof (destType.sourceNode) === 'string' || destType.sourceNode.nodeName !== NodeName.Class) {
            return false;
        }
        return srcNode.identifier.text === destType.sourceNode.identifier.text;
    }

    return false;
}

// INITLIST      ::= '{' [ASSIGN | INITLIST] {',' [ASSIGN | INITLIST]} '}'
function analyzeINITLIST(scope: SymbolScope, ast: NodeExpr) {
    // TODO
}

// SCOPE         ::= ['::'] {IDENTIFIER '::'} [IDENTIFIER ['<' TYPE {',' TYPE} '>'] '::']
function analyzeScope(symbolScope: SymbolScope, nodeScope: NodeScope): SymbolScope | undefined {
    let scopeIterator = symbolScope;
    if (nodeScope.isGlobal) {
        scopeIterator = findGlobalScope(symbolScope);
    }
    for (let i = 0; i < nodeScope.scopeList.length; i++) {
        const nextScope = nodeScope.scopeList[i];

        // 名前に対応するスコープを探す
        let found: SymbolScope | undefined = undefined;
        for (; ;) {
            found = findScopeByIdentifier(scopeIterator, nextScope.text);
            if (found !== undefined) break;
            if (i == 0 && scopeIterator.parentScope !== undefined) {
                // グローバルスコープでないなら、上の階層を更に探索
                scopeIterator = scopeIterator.parentScope;
            } else {
                diagnostic.addError(nextScope.location, `Undefined scope: ${nextScope.text}`);
                return undefined;
            }
        }

        // スコープを更新
        scopeIterator = found;

        // 名前空間に対する補完を行う
        const complementRange: Range = {start: nextScope.location.start, end: nextScope.location.end};
        complementRange.end = getNextTokenIfExist(getNextTokenIfExist(nextScope)).location.start;
        symbolScope.completionHints.push({
            complementKind: NodeName.Namespace,
            complementRange: complementRange,
            namespaceList: nodeScope.scopeList.slice(0, i + 1)
        });

    }

    return scopeIterator;
}

// DATATYPE      ::= (IDENTIFIER | PRIMTYPE | '?' | 'auto')
// PRIMTYPE      ::= 'void' | 'int' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'float' | 'double' | 'bool'
// FUNCATTR      ::= {'override' | 'final' | 'explicit' | 'property'}

// STATEMENT     ::= (IF | FOR | WHILE | RETURN | STATBLOCK | BREAK | CONTINUE | DOWHILE | SWITCH | EXPRSTAT | TRY)
function analyzeStatement(scope: SymbolScope, ast: NodeStatement) {
    switch (ast.nodeName) {
    case NodeName.If:
        analyzeIF(scope, ast);
        break;
    case NodeName.For:
        analyzeFOR(scope, ast);
        break;
    case NodeName.While:
        analyzeWHILE(scope, ast);
        break;
    case NodeName.Return:
        analyzeRETURN(scope, ast);
        break;
    case NodeName.StatBlock:
        analyzeStatBlock(scope, ast);
        break;
    case NodeName.Break:
        break;
    case NodeName.Continue:
        break;
    case NodeName.DoWhile:
        analyzeDOWHILE(scope, ast);
        break;
    case NodeName.Switch:
        analyzeSWITCH(scope, ast);
        break;
    case NodeName.ExprStat:
        analyzeEXPRSTAT(scope, ast);
        break;
        // case NodeName.Try:
        //     break;
    default:
        break;
    }
}

// SWITCH        ::= 'switch' '(' ASSIGN ')' '{' {CASE} '}'
function analyzeSWITCH(scope: SymbolScope, ast: NodeSwitch) {
    analyzeAssign(scope, ast.assign);
    for (const c of ast.cases) {
        analyzeCASE(scope, c);
    }
}

// BREAK         ::= 'break' ';'

// FOR           ::= 'for' '(' (VAR | EXPRSTAT) EXPRSTAT [ASSIGN {',' ASSIGN}] ')' STATEMENT
function analyzeFOR(scope: SymbolScope, ast: NodeFor) {
    if (ast.initial.nodeName === NodeName.Var) analyzeVar(scope, ast.initial);
    else analyzeEXPRSTAT(scope, ast.initial);

    analyzeEXPRSTAT(scope, ast.condition);

    for (const inc of ast.incrementList) {
        analyzeAssign(scope, inc);
    }

    analyzeStatement(scope, ast.statement);
}

// WHILE         ::= 'while' '(' ASSIGN ')' STATEMENT
function analyzeWHILE(scope: SymbolScope, ast: NodeWhile) {
    analyzeAssign(scope, ast.assign);
    analyzeStatement(scope, ast.statement);
}

// DOWHILE       ::= 'do' STATEMENT 'while' '(' ASSIGN ')' ';'
function analyzeDOWHILE(scope: SymbolScope, ast: NodeDoWhile) {
    analyzeStatement(scope, ast.statement);
    analyzeAssign(scope, ast.assign);
}

// IF            ::= 'if' '(' ASSIGN ')' STATEMENT ['else' STATEMENT]
function analyzeIF(scope: SymbolScope, ast: NodeIf) {
    analyzeAssign(scope, ast.condition);
    analyzeStatement(scope, ast.ts);
    if (ast.fs !== undefined) analyzeStatement(scope, ast.fs);
}

// CONTINUE      ::= 'continue' ';'

// EXPRSTAT      ::= [ASSIGN] ';'
function analyzeEXPRSTAT(scope: SymbolScope, ast: NodeExprStat) {
    if (ast.assign !== undefined) analyzeAssign(scope, ast.assign);
}

// TRY           ::= 'try' STATBLOCK 'catch' STATBLOCK

// RETURN        ::= 'return' [ASSIGN] ';'
function analyzeRETURN(scope: SymbolScope, ast: NodeReturn) {
    analyzeAssign(scope, ast.assign);
}

// CASE          ::= (('case' EXPR) | 'default') ':' {STATEMENT}
function analyzeCASE(scope: SymbolScope, ast: NodeCASE) {
    if (ast.expr !== undefined) analyzeExpr(scope, ast.expr);
    for (const statement of ast.statementList) {
        analyzeStatement(scope, statement);
    }
}

// EXPR          ::= EXPRTERM {EXPROP EXPRTERM}
function analyzeExpr(scope: SymbolScope, ast: NodeExpr): DeducedType | undefined {
    const lhs = analyzeExprTerm(scope, ast.head);
    // TODO: 型チェック
    if (ast.tail !== undefined) {
        const rhs = analyzeExpr(scope, ast.tail.expression);
        // if (lhs !== undefined && rhs !== undefined) checkTypeMatch(lhs, rhs);
    }
    return lhs;
}

// EXPRTERM      ::= ([TYPE '='] INITLIST) | ({EXPRPREOP} EXPRVALUE {EXPRPOSTOP})
function analyzeExprTerm(scope: SymbolScope, ast: NodeExprTerm): DeducedType | undefined {
    if (ast.exprTerm === 1) {
        // TODO
    } else if (ast.exprTerm === 2) {
        return analyzeExprTerm2(scope, ast);
    }
    return undefined;
}

function analyzeExprTerm2(scope: SymbolScope, exprTerm: NodeExprTerm2) {
    const exprValue = analyzeExprValue(scope, exprTerm.value);
    if (exprTerm.postOp !== undefined && exprValue !== undefined) {
        analyzeExprPostOp(scope, exprTerm.postOp, exprValue.symbol);
    }
    return exprValue;
}

// EXPRVALUE     ::= 'void' | CONSTRUCTCALL | FUNCCALL | VARACCESS | CAST | LITERAL | '(' ASSIGN ')' | LAMBDA
function analyzeExprValue(scope: SymbolScope, exprValue: NodeExprValue): DeducedType | undefined {
    switch (exprValue.nodeName) {
    case NodeName.ConstructCall:
        break;
    case NodeName.FuncCall:
        return analyzeFuncCall(scope, exprValue);
    case NodeName.VarAccess:
        return analyzeVarAccess(scope, exprValue);
    case NodeName.Cast:
        break;
    case NodeName.Literal:
        return analyzeLITERAL(scope, exprValue);
    case NodeName.Assign:
        return analyzeAssign(scope, exprValue);
    case NodeName.Lambda:
        break;
    default:
        break;
    }
    return undefined;
}

// CONSTRUCTCALL ::= TYPE ARGLIST
// EXPRPREOP     ::= '-' | '+' | '!' | '++' | '--' | '~' | '@'

// EXPRPOSTOP    ::= ('.' (FUNCCALL | IDENTIFIER)) | ('[' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':' ASSIGN} ']') | ARGLIST | '++' | '--'
function analyzeExprPostOp(scope: SymbolScope, exprPostOp: NodeExprPostOp, exprValue: SymbolicType) {
    if (exprPostOp.postOp === 1) {
        return analyzeExprPostOp1(scope, exprPostOp, exprValue);
    }
}

function analyzeExprPostOp1(scope: SymbolScope, exprPostOp: NodeExprPostOp1, exprValue: SymbolicType) {
    const complementRange = getNodeLocation(exprPostOp.nodeRange);

    // メンバが存在しない場合は、次のトークンまでを補完範囲とする
    if (exprPostOp.member === undefined) {
        complementRange.end = getNextTokenIfExist(exprPostOp.nodeRange.end).location.start;
    }

    // クラスメンバ補完
    scope.completionHints.push({
        complementKind: NodeName.Type,
        complementRange: complementRange,
        targetType: exprValue
    });

    if (exprPostOp.member === undefined) return undefined;

    if ('nodeName' in exprPostOp.member) {
        // メソッド診断
        if (typeof (exprValue.sourceNode) === 'string' || exprValue.sourceNode.nodeName !== NodeName.Class) {
            diagnostic.addError(exprPostOp.member.identifier.location, `Undefined member: ${exprPostOp.member.identifier.text}`);
            return undefined;
        }

        const classScope = findClassScopeWithParent(scope, exprValue.sourceNode.identifier.text);
        if (classScope === undefined) {
            diagnostic.addError(exprPostOp.member.identifier.location, `Undefined class: ${exprValue.sourceNode.identifier.text}`);
            return undefined;
        }

        return analyzeFuncCall(classScope, exprPostOp.member);
    } else {
        // フィールド診断
        // TODO
    }
}

// CAST          ::= 'cast' '<' TYPE '>' '(' ASSIGN ')'
// LAMBDA        ::= 'function' '(' [[TYPE TYPEMOD] [IDENTIFIER] {',' [TYPE TYPEMOD] [IDENTIFIER]}] ')' STATBLOCK
// LITERAL       ::= NUMBER | STRING | BITS | 'true' | 'false' | 'null'
function analyzeLITERAL(scope: SymbolScope, literal: NodeLiteral): DeducedType | undefined {
    if (literal.value.kind === TokenKind.Number) {
        return {symbol: builtinNumberType};
    }
    const literalText = literal.value.text;
    if (literalText === 'true' || literalText === 'false') {
        return {symbol: builtinBoolType};
    }
    // TODO
    return undefined;
}

// FUNCCALL      ::= SCOPE IDENTIFIER ARGLIST
function analyzeFuncCall(scope: SymbolScope, funcCall: NodeFuncCall): DeducedType | undefined {
    if (funcCall.scope !== undefined) {
        const namespaceScope = analyzeScope(scope, funcCall.scope);
        if (namespaceScope === undefined) return undefined;
        scope = namespaceScope;
    }
    const calleeFunc = findSymbolicFunctionWithParent(scope, funcCall.identifier.text);
    if (calleeFunc === undefined) {
        diagnostic.addError(funcCall.identifier.location, `Undefined function: ${funcCall.identifier.text}`);
        return undefined;
    }
    return analyzeFunctionCall(scope, funcCall, calleeFunc);
}

function analyzeFunctionCall(scope: SymbolScope, funcCall: NodeFuncCall, calleeFunc: SymbolicFunction) {
    const head = calleeFunc.sourceNode.head;
    const returnType = isFunctionHeadReturns(head) ? analyzeType(scope, head.returnType) : undefined;
    scope.referencedList.push({
        declaredSymbol: calleeFunc,
        referencedToken: funcCall.identifier
    });
    const argTypes = analyzeArgList(scope, funcCall.argList);
    if (argTypes.length === calleeFunc.sourceNode.paramList.length) {
        for (let i = 0; i < argTypes.length; i++) {
            const actualType = argTypes[i];
            const expectedType = findSymbolicTypeWithParent(scope, calleeFunc.sourceNode.paramList[i].type.datatype.identifier);
            if (actualType === undefined || expectedType === undefined) continue;
            if (isTypeMatch(actualType, {symbol: expectedType}) === false) {
                diagnostic.addError(getNodeLocation(funcCall.argList.argList[i].assign.nodeRange), `Argument type mismatch: ${funcCall.identifier.text}`);
            }
        }
    } else {
        diagnostic.addError(funcCall.identifier.location, `Argument count mismatch: ${funcCall.identifier.text}`);
    }
    return returnType;
}

// VARACCESS     ::= SCOPE IDENTIFIER
function analyzeVarAccess(scope: SymbolScope, varAccess: NodeVarAccess): DeducedType | undefined {
    if (varAccess.scope !== undefined) {
        const namespaceScope = analyzeScope(scope, varAccess.scope);
        if (namespaceScope === undefined) return undefined;
        scope = namespaceScope;
    }

    if (varAccess.identifier === undefined) {
        return undefined;
    }

    const token = varAccess.identifier;
    const declared = findSymbolicVariableWithParent(scope, token.text);
    if (declared === undefined) {
        diagnostic.addError(token.location, `Undefined variable: ${token.text}`);
        return undefined;
    }
    scope.referencedList.push({
        declaredSymbol: declared,
        referencedToken: token
    });
    return declared.type === undefined ? undefined : {symbol: declared.type};
}

// ARGLIST       ::= '(' [IDENTIFIER ':'] ASSIGN {',' [IDENTIFIER ':'] ASSIGN} ')'
function analyzeArgList(scope: SymbolScope, argList: NodeArgList): (DeducedType | undefined)[] {
    const types: (DeducedType | undefined)[] = [];
    for (const arg of argList.argList) {
        types.push(analyzeAssign(scope, arg.assign));
    }
    return types;
}

// ASSIGN        ::= CONDITION [ ASSIGNOP ASSIGN ]
function analyzeAssign(scope: SymbolScope, assign: NodeAssign): DeducedType | undefined {
    const lhs = analyzeCondition(scope, assign.condition);
    if (assign.tail === undefined) return lhs;
    const rhs = analyzeAssign(scope, assign.tail.assign);
    // if (lhs !== undefined && rhs !== undefined) checkTypeMatch(lhs, rhs);
    return lhs;
}

// CONDITION     ::= EXPR ['?' ASSIGN ':' ASSIGN]
export function analyzeCondition(scope: SymbolScope, condition: NodeCondition): DeducedType | undefined {
    const exprType = analyzeExpr(scope, condition.expr);
    if (condition.ternary === undefined) return exprType;
    const ta = analyzeAssign(scope, condition.ternary.ta);
    const fa = analyzeAssign(scope, condition.ternary.fa);
    // if (ta !== undefined && fa !== undefined) checkTypeMatch(ta, fa);
    return ta;
}

export function analyzeFromParsed(ast: NodeScript, path: string, includedScopes: AnalyzedScope[]): AnalyzedScope {
    const globalScope: SymbolScope = createSymbolScope(undefined, undefined);

    for (const included of includedScopes) {
        // インクルードされたスコープのシンボルをコピー
        copySymbolsInScope(included.pureScope, globalScope);
    }

    const queue: AnalyzeQueue = {
        classQueue: [],
        funcQueue: [],
    };

    // 宣言されたシンボルを収集
    forwardScript(globalScope, ast, queue);

    // スコープの中身を解析
    analyzeScript(queue, globalScope, ast);

    return new AnalyzedScope(path, globalScope);
}
