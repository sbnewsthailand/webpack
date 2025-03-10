import { obj1 }  from './module1';
import * as m_1 from './module1';
import * as m_2 from './module2';
import * as m_3 from './module3';
import data from "./data";

const { expectSourceToContain } = require("../../../helpers/expectSource");

// It's important to preserve the same accessor syntax (quotes vs. dot notatation) after the actual export variable.
// Else, minifiers such as Closure Compiler will not be able to minify correctly in ADVANCED mode.

it("should use/preserve accessor form for import object and namespaces", function() {
	var fs = require("fs");
	var source = fs.readFileSync(__filename, "utf-8").toString();

	// Reference the imports to generate uses in the source.

	const f = false;
	if (f) {
		const x1 = m_1;
		const x2 = obj1;

		const z1 = obj1["plants"];
		const z2 = obj1["funcs"]();
		const z3 = m_1["obj1"]["pots"];
		const z4 = m_1["obj1"]["subs"]();

		const a = m_2["m_1"].obj1["flip"].flap;
		const b = m_2["m_1"]["obj1"].zip["zap"];
		const c = m_2.m_1.obj1["ding"].dong();
		const d = m_2.m_1["obj1"].sing["song"]();

		const aa = m_3["m_2"].m_1["obj1"]["zoom"];

		const bb = obj1.up.down?.left.right;

		data.nested.object3["unknownProperty"].depth = "deep";
	}

	/************ DO NOT MATCH BELOW THIS LINE ************/

	// Imported objects and import namespaces should use dot notation.  Any references to the properties of exports
	// should be preserved as either quotes or dot notation, depending on the original source.

	expectSourceToContain(source, 'const x1 = _module1__WEBPACK_IMPORTED_MODULE_0__;');
	expectSourceToContain(source, 'const x2 = _module1__WEBPACK_IMPORTED_MODULE_0__.obj1;');

	expectSourceToContain(source, 'const z1 = _module1__WEBPACK_IMPORTED_MODULE_0__.obj1["plants"];');
	expectSourceToContain(source, 'const z2 = _module1__WEBPACK_IMPORTED_MODULE_0__.obj1["funcs"]();');
	expectSourceToContain(source, 'const z3 = _module1__WEBPACK_IMPORTED_MODULE_0__.obj1["pots"];');
	expectSourceToContain(source, 'const z4 = _module1__WEBPACK_IMPORTED_MODULE_0__.obj1["subs"]();');

	expectSourceToContain(source, 'const a = _module2__WEBPACK_IMPORTED_MODULE_1__.m_1.obj1["flip"].flap;');
	expectSourceToContain(source, 'const b = _module2__WEBPACK_IMPORTED_MODULE_1__.m_1.obj1.zip["zap"];');
	expectSourceToContain(source, 'const c = _module2__WEBPACK_IMPORTED_MODULE_1__.m_1.obj1["ding"].dong();');
	expectSourceToContain(source, 'const d = _module2__WEBPACK_IMPORTED_MODULE_1__.m_1.obj1.sing["song"]();');

	expectSourceToContain(source, 'const aa = _module3__WEBPACK_IMPORTED_MODULE_2__.m_2.m_1.obj1["zoom"];');

	expectSourceToContain(source, 'const bb = _module1__WEBPACK_IMPORTED_MODULE_0__.obj1.up.down?.left.right;');

	expectSourceToContain(source, '_data__WEBPACK_IMPORTED_MODULE_3__.nested.object3["unknownProperty"].depth = "deep";');

});
