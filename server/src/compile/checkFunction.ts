import {diagnostic} from "../code/diagnostic";
import {ParsedRange} from "./nodes";
import {
    DeducedType,
    SymbolFunction,
    SymbolScope
} from "./symbols";
import {isTypeMatch} from "./checkType";
import {ParsedToken} from "./parsedToken";
import {getNodeLocation, stringifyNodeType} from "./nodesUtils";
import {resolveTemplateTypes, stringifyDeducedType, stringifyDeducedTypes, TemplateTranslation} from "./symbolUtils";

export interface FunctionMatchingArgs {
    scope: SymbolScope;
    callerIdentifier: ParsedToken;
    callerRange: ParsedRange;
    callerArgRanges: ParsedRange[];
    callerArgTypes: (DeducedType | undefined)[];
    calleeFunc: SymbolFunction;
    templateTranslators: (TemplateTranslation | undefined)[];
}

/**
 * Checks whether the arguments provided by the caller match the parameters of the function definition.
 * @param args
 */
export function checkFunctionMatch(
    args: FunctionMatchingArgs
): DeducedType | undefined {
    pushReferenceOfFuncOrConstructor(args.callerIdentifier, args.scope, args.calleeFunc);
    return checkFunctionMatchInternal(args, args.calleeFunc);
}

function pushReferenceOfFuncOrConstructor(callerIdentifier: ParsedToken, scope: SymbolScope, calleeFunc: SymbolFunction) {
    scope.referencedList.push({declaredSymbol: calleeFunc, referencedToken: callerIdentifier});
}

function checkFunctionMatchInternal(
    args: FunctionMatchingArgs,
    overloadedHead: SymbolFunction
): DeducedType | undefined {
    const {scope, callerRange, callerArgRanges, callerArgTypes, calleeFunc, templateTranslators} = args;
    const calleeParams = calleeFunc.sourceNode.paramList;

    if (callerArgTypes.length > calleeParams.length) {
        // Handle too many caller arguments.
        return handleTooMuchCallerArgs(args, overloadedHead);
    }

    for (let i = 0; i < calleeParams.length; i++) {
        if (i >= callerArgTypes.length) {
            // When the caller arguments are insufficient
            const param = calleeParams[i];

            if (param.defaultExpr !== undefined) continue;

            // When there is also no default expression

            if (calleeFunc.nextOverload !== undefined) {
                return checkFunctionMatchInternal({...args, calleeFunc: calleeFunc.nextOverload}, overloadedHead);
            }

            if (handleErrorWhenOverloaded(callerRange, callerArgTypes, calleeFunc, overloadedHead, templateTranslators) === false) {
                diagnostic.addError(getNodeLocation(callerRange), `Missing argument for parameter '${stringifyNodeType(param.type)}'.`);
            }

            break;
        }

        let actualType = callerArgTypes[i];
        let expectedType = calleeFunc.parameterTypes[i];
        actualType = resolveTemplateTypes(templateTranslators, actualType);
        expectedType = resolveTemplateTypes(templateTranslators, expectedType);

        if (isTypeMatch(actualType, expectedType)) continue;

        // Use the overload if it exists
        if (calleeFunc.nextOverload !== undefined) {
            return checkFunctionMatchInternal({...args, calleeFunc: calleeFunc.nextOverload}, overloadedHead);
        }

        if (handleErrorWhenOverloaded(callerRange, callerArgTypes, calleeFunc, overloadedHead, templateTranslators) === false) {
            diagnostic.addError(getNodeLocation(callerRange),
                `Cannot convert '${stringifyDeducedType(actualType)}' to parameter type '${stringifyDeducedType(expectedType)}'.`);
        }
    }

    return resolveTemplateTypes(templateTranslators, calleeFunc.returnType);
}

function handleTooMuchCallerArgs(args: FunctionMatchingArgs, overloadedHead: SymbolFunction) {
    const {scope, callerRange, callerArgRanges, callerArgTypes, calleeFunc, templateTranslators} = args;

    // Use the overload if it exists
    if (calleeFunc.nextOverload !== undefined) {
        return checkFunctionMatchInternal({...args, calleeFunc: calleeFunc.nextOverload}, overloadedHead);
    }

    if (handleErrorWhenOverloaded(callerRange, callerArgTypes, calleeFunc, overloadedHead, templateTranslators) === false) {
        diagnostic.addError(getNodeLocation(callerRange),
            `Function has ${calleeFunc.sourceNode.paramList.length} parameters, but ${callerArgTypes.length} were provided.`);
    }

    return calleeFunc.returnType;
}

function handleErrorWhenOverloaded(
    callerRange: ParsedRange,
    callerArgs: (DeducedType | undefined)[],
    calleeFunc: SymbolFunction,
    overloadedHead: SymbolFunction,
    templateTranslators: (TemplateTranslation | undefined)[]
) {
    if (calleeFunc === overloadedHead) return false; // Not overloaded

    let message = 'No viable function.';
    message += `\nArguments types: (${stringifyDeducedTypes(callerArgs)})`;
    message += '\nCandidates considered:';

    let cursor: SymbolFunction | undefined = overloadedHead;
    while (cursor !== undefined) {
        const resolvedTypes = cursor.parameterTypes.map(t => resolveTemplateTypes(templateTranslators, t));
        message += `\n(${stringifyDeducedTypes(resolvedTypes)})`;
        cursor = cursor.nextOverload;
    }

    diagnostic.addError(getNodeLocation(callerRange), message);
    return true;
}
