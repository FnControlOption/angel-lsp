import {SymbolScope} from "../compile/symbolic";
import {Position} from "vscode-languageserver";
import {ParsingToken} from "../compile/parsingToken";
import {serveDefinition} from "./definition";
import {isPositionInRange, isSameToken} from "../compile/tokens";
import {AnalyzedScope} from "../compile/scope";

export function serveReferences(targetScope: AnalyzedScope, analyzedScopes: SymbolScope[], caret: Position): ParsingToken[] {
    const targetDefinition = serveDefinition(targetScope, caret);
    if (targetDefinition === null) return [];

    // FIXME: 参照収集の前に、依存関係のあるファイルをリフレッシュする必要がある

    const result = analyzedScopes.flatMap(scope => collectReferencesInScope(scope, targetDefinition));
    result.push(targetDefinition);
    return result;
}

function collectReferencesInScope(scope: SymbolScope, targetDefinition: ParsingToken): ParsingToken[] {
    const references = [];

    for (const reference of scope.referencedList) {
        // スコープ内の参照箇所を検索 (コンパイルのたびにトークンのインスタンスが変わるので、厳密な比較を行う必要がある)
        if (reference.declaredSymbol.declaredPlace === targetDefinition || isSameToken(reference.declaredSymbol.declaredPlace, targetDefinition)) {
            references.push(reference.referencedToken);
        }
    }

    // 子要素も探索
    for (const [key, child] of scope.childScopes) {
        references.push(...collectReferencesInScope(child, targetDefinition));
    }

    return references;
}
