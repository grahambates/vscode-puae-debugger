import { demangle, isMangled } from '../demangle';

describe('Free Functions', () => {
  it('receives an unmangled name', () => {
    expect(demangle("main(int, char**)")).toBe("main(int, char**)");
  });
  it('receives nothing, return void', () => {
    expect(demangle("_Z7doThingv")).toBe("doThing()");
  });
  it('receives boolean', () => {
    expect(demangle("_Z6isBoolb")).toBe("isBool(bool)");
  });
  it('receives unsigned short', () => {
    expect(demangle("_Z7isShortt")).toBe("isShort(unsigned short)");
  });
  it('receives short', () => {
    expect(demangle("_Z7isShorts")).toBe("isShort(short)");
  });
  it('receives unsigned char', () => {
    expect(demangle("_Z6isCharh")).toBe("isChar(unsigned char)");
  });
  it('receives signed char', () => {
    expect(demangle("_Z6isChara")).toBe("isChar(signed char)");
  });
  it('receives wide char', () => {
    expect(demangle("_Z6isCharw")).toBe("isChar(wchar_t)");
  });
  it('receives wide char pointer', () => {
    expect(demangle("_Z6isCharPw")).toBe("isChar(wchar_t*)");
  });
  it('receives integer', () => {
    expect(demangle("_Z5isInti")).toBe("isInt(int)");
  });
  it('receives long', () => {
    expect(demangle("_Z9test_longl")).toBe("test_long(long)");
  });
  it('receives volatile pointer to long', () => {
    expect(demangle("_Z9dangerousPVl")).toBe("dangerous(volatile long*)");
  });
  it('receives long long', () => {
    expect(demangle("_Z9test_longx")).toBe("test_long(long long)");
  });
  it('receives unsigned int', () => {
    expect(demangle("_Z9test_uintj")).toBe("test_uint(unsigned int)");
  });
  it('receives size_t', () => {
    expect(demangle("_Z10test_sizetm")).toBe("test_sizet(unsigned long)");
  });
  it('receives signed size_t', () => {
    expect(demangle("_Z11test_ssizetl")).toBe("test_ssizet(long)");
  });
  it('receives double', () => {
    expect(demangle("_Z5isIntd")).toBe("isInt(double)");
  });
  it('receives double+int', () => {
    expect(demangle("_Z5isIntdi")).toBe("isInt(double, int)");
  });
  it('receives const char ptr', () => {
    expect(demangle("_Z13testConstCharPKc")).toBe("testConstChar(const char*)");
  });
  it('receives const restrict char ptrs', () => {
    expect(demangle("_Z6strcpyPrKcPrc")).toBe("strcpy(const char* restrict, char* restrict)");
  });
  it('receives double char ptr', () => {
    expect(demangle("_Z11testCharPtrPPc")).toBe("testCharPtr(char**)");
  });
  it('receives char ptr', () => {
    expect(demangle("_Z11testCharPtrPc")).toBe("testCharPtr(char*)");
  });
  it('receives reference to an int', () => {
    expect(demangle("_Z16testIntReferenceRi")).toBe("testIntReference(int&)");
  });
  it('receives reference to an int and a double', () => {
    expect(demangle("_Z16testIntReferenceRid")).toBe("testIntReference(int&, double)");
  });
  it('receives a custom struct', () => {
    expect(demangle("_Z16testCustomStruct11test_struct")).toBe("testCustomStruct(test_struct)");
  });
  it('receives a pointer to a custom struct', () => {
    expect(demangle("_Z16testCustomStructP11test_struct")).toBe("testCustomStruct(test_struct*)");
  });
  it('receives a reference to a custom struct', () => {
    expect(demangle("_Z16testCustomStructR11test_struct")).toBe("testCustomStruct(test_struct&)");
  });
  it('receives a custom struct and an int', () => {
    expect(demangle("_Z16testCustomStruct11test_structi")).toBe("testCustomStruct(test_struct, int)");
  });
});

describe('classes', () => {
  it('public function, receives nothing', () => {
    expect(demangle("_ZN10test_class4testEv")).toBe("test_class::test()");
  });
  it('public function, receives an integer', () => {
    expect(demangle("_ZN10test_class4testEi")).toBe("test_class::test(int)");
  });
  it('private function, receives nothing', () => {
    expect(demangle("_ZN10test_class12test_privateEv")).toBe("test_class::test_private()");
  });
  it('private function, receives an integer', () => {
    expect(demangle("_ZN10test_class12test_privateEi")).toBe("test_class::test_private(int)");
  });
  it('free function, receives a class', () => {
    expect(demangle("_Z21function_return_class10test_class")).toBe("function_return_class(test_class)");
  });
  it('free function, receives a class ref', () => {
    expect(demangle("_Z21function_return_classR10test_class")).toBe("function_return_class(test_class&)");
  });
  it('free function, receives a class ptr', () => {
    expect(demangle("_Z21function_return_classP10test_class")).toBe("function_return_class(test_class*)");
  });
});

describe('namespaces', () => {
  it('receives integer', () => {
    expect(demangle("_ZN4test14testNamespacedEi")).toBe("test::testNamespaced(int)");
  });
  it('receives integer and a struct within another namespace', () => {
    expect(demangle("_ZN4test14testNamespacedEiN9othertest10teststructE")).toBe("test::testNamespaced(int, othertest::teststruct)");
  });
  it('receives integer and a reference to a struct within another namespace', () => {
    expect(demangle("_ZN4test14testNamespacedEiRN9othertest10teststructE")).toBe("test::testNamespaced(int, othertest::teststruct&)");
  });
});

describe('std types', () => {
  it('receives std::string', () => {
    expect(demangle("_Z10testStringNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE")).toBe(
      "testString(std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char>>)");
  });
  it('receives std::string ref', () => {
    expect(demangle("_Z10testStringRNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE")).toBe(
      "testString(std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char>>&)");
  });
  it('receives std::string rvalue', () => {
    expect(demangle("_Z18test_rvalue_stringONSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE")).toBe(
      "test_rvalue_string(std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char>>&&)");
  });
  it('receives std::vector<int>', () => {
    expect(demangle("_Z10testVectorSt6vectorIiSaIiEE")).toBe("testVector(std::vector<int, std::allocator<int>>)");
  });
  it('receives std::queue<float>', () => {
    expect(demangle("_Z10test_queueSt5queueIfSt5dequeIfSaIfEEE")).toBe(
      "test_queue(std::queue<float, std::deque<float, std::allocator<float>>>)");
  });
});

describe('numeric types', () => {
  it('receives float', () => {
    expect(demangle("_Z9testFloatf")).toBe("testFloat(float)");
  });
  it('receives long double', () => {
    expect(demangle("_Z14testLongDoublee")).toBe("testLongDouble(long double)");
  });
  it('receives __int128', () => {
    expect(demangle("_Z10testInt128n")).toBe("testInt128(__int128)");
  });
  it('receives unsigned __int128', () => {
    expect(demangle("_Z11testUInt128o")).toBe("testUInt128(unsigned __int128)");
  });
  it('receives __float128', () => {
    expect(demangle("_Z12testFloat128g")).toBe("testFloat128(__float128)");
  });
  it('receives unsigned long long', () => {
    expect(demangle("_Z8testULLIy")).toBe("testULLI(unsigned long long)");
  });
});

describe('qualifiers and modifiers', () => {
  it('receives const int', () => {
    expect(demangle("_Z12testConstIntKi")).toBe("testConstInt(const int)");
  });
  it('receives volatile int', () => {
    expect(demangle("_Z15testVolatileIntVi")).toBe("testVolatileInt(volatile int)");
  });
  it('receives const volatile int', () => {
    expect(demangle("_Z20testConstVolatileIntVKi")).toBe("testConstVolatileInt(const volatile int)");
  });
  it('receives rvalue reference to int', () => {
    expect(demangle("_Z16testRvalueRefIntOi")).toBe("testRvalueRefInt(int&&)");
  });
  it('receives multiple pointers', () => {
    expect(demangle("_Z13testTriplePtrPPPi")).toBe("testTriplePtr(int***)");
  });
  it('receives pointer to const int', () => {
    expect(demangle("_Z14testPtrToConstPKi")).toBe("testPtrToConst(const int*)");
  });
});

describe('std abbreviated types', () => {
  it('receives std::allocator', () => {
    expect(demangle("_Z13testAllocatorSaIiE")).toBe("testAllocator(std::allocator<int>)");
  });
  it('receives std::basic_string', () => {
    expect(demangle("_Z15testBasicStringSbIwE")).toBe("testBasicString(std::basic_string<wchar_t>)");
  });
  it('receives std::basic_istream', () => {
    expect(demangle("_Z11testIstreamSi")).toBe("testIstream(std::basic_istream<char, std::char_traits<char>>)");
  });
  it('receives std::basic_ostream', () => {
    expect(demangle("_Z11testOstreamSo")).toBe("testOstream(std::basic_ostream<char, std::char_traits<char>>)");
  });
  it('receives std::basic_iostream', () => {
    expect(demangle("_Z12testIostreamSd")).toBe("testIostream(std::basic_iostream<char, std::char_traits<char>>)");
  });
  it('receives std::string (abbreviated)', () => {
    expect(demangle("_Z10testStringSs")).toBe("testString(std::basic_string<char, std::char_traits<char>, std::allocator<char>>)");
  });
});

describe('variadic functions', () => {
  it('receives variadic arguments', () => {
    expect(demangle("_Z6printfPKcz")).toBe("printf(const char*, ...)");
  });
});

describe('multiple parameters', () => {
  it('receives multiple types mixed', () => {
    expect(demangle("_Z11mixedParamsibfdPKc")).toBe("mixedParams(int, bool, float, double, const char*)");
  });
  it('receives pointers and references mixed', () => {
    expect(demangle("_Z9mixedModsPiRiOi")).toBe("mixedMods(int*, int&, int&&)");
  });
});

describe('nested namespaces', () => {
  it('handles deeply nested namespaces', () => {
    expect(demangle("_ZN5outer5inner4deep8functionEv")).toBe("outer::inner::deep::function()");
  });
  it('handles namespace with custom type', () => {
    expect(demangle("_ZN2ns8functionEN4data6customE")).toBe("ns::function(data::custom)");
  });
});

describe('operator overloading', () => {
  describe('arithmetic operators', () => {
    it('handles operator+', () => { expect(demangle("_ZN6NumberplERKS_")).toBe("Number::operator+(const Number&)"); });
    it('handles operator-', () => { expect(demangle("_ZN6NumbermiERKS_")).toBe("Number::operator-(const Number&)"); });
    it('handles operator*', () => { expect(demangle("_ZN6NumbermlERKS_")).toBe("Number::operator*(const Number&)"); });
    it('handles operator/', () => { expect(demangle("_ZN6NumberdvERKS_")).toBe("Number::operator/(const Number&)"); });
    it('handles operator%', () => { expect(demangle("_ZN6NumberrmERKS_")).toBe("Number::operator%(const Number&)"); });
  });

  describe('comparison operators', () => {
    it('handles operator==',          () => { expect(demangle("_ZN6NumbereqERKS_")).toBe("Number::operator==(const Number&)"); });
    it('handles operator!=',          () => { expect(demangle("_ZN6NumberneERKS_")).toBe("Number::operator!=(const Number&)"); });
    it('handles operator<',           () => { expect(demangle("_ZN6NumberltERKS_")).toBe("Number::operator<(const Number&)"); });
    it('handles operator>',           () => { expect(demangle("_ZN6NumbergtERKS_")).toBe("Number::operator>(const Number&)"); });
    it('handles operator<=',          () => { expect(demangle("_ZN6NumberleERKS_")).toBe("Number::operator<=(const Number&)"); });
    it('handles operator>=',          () => { expect(demangle("_ZN6NumbergeERKS_")).toBe("Number::operator>=(const Number&)"); });
    it('handles operator<=> (spaceship)', () => { expect(demangle("_ZN6NumberssERKS_")).toBe("Number::operator<=>(const Number&)"); });
  });

  describe('assignment operators', () => {
    it('handles operator=',  () => { expect(demangle("_ZN6NumberaSERKS_")).toBe("Number::operator=(const Number&)"); });
    it('handles operator+=', () => { expect(demangle("_ZN6NumberpLERKS_")).toBe("Number::operator+=(const Number&)"); });
    it('handles operator-=', () => { expect(demangle("_ZN6NumbermIERKS_")).toBe("Number::operator-=(const Number&)"); });
    it('handles operator*=', () => { expect(demangle("_ZN6NumbermLERKS_")).toBe("Number::operator*=(const Number&)"); });
    it('handles operator/=', () => { expect(demangle("_ZN6NumberdVERKS_")).toBe("Number::operator/=(const Number&)"); });
    it('handles operator%=', () => { expect(demangle("_ZN6NumberrMERKS_")).toBe("Number::operator%=(const Number&)"); });
  });

  describe('bitwise operators', () => {
    it('handles operator&',   () => { expect(demangle("_ZN6NumberanERKS_")).toBe("Number::operator&(const Number&)"); });
    it('handles operator|',   () => { expect(demangle("_ZN6NumberorERKS_")).toBe("Number::operator|(const Number&)"); });
    it('handles operator^',   () => { expect(demangle("_ZN6NumbereoERKS_")).toBe("Number::operator^(const Number&)"); });
    it('handles operator~',   () => { expect(demangle("_ZN6NumbercoEv")).toBe("Number::operator~()"); });
    it('handles operator<<',  () => { expect(demangle("_ZN6NumberlsERKS_")).toBe("Number::operator<<(const Number&)"); });
    it('handles operator>>',  () => { expect(demangle("_ZN6NumberrsERKS_")).toBe("Number::operator>>(const Number&)"); });
    it('handles operator&=',  () => { expect(demangle("_ZN6NumberaNERKS_")).toBe("Number::operator&=(const Number&)"); });
    it('handles operator|=',  () => { expect(demangle("_ZN6NumberoRERKS_")).toBe("Number::operator|=(const Number&)"); });
    it('handles operator^=',  () => { expect(demangle("_ZN6NumbereOERKS_")).toBe("Number::operator^=(const Number&)"); });
    it('handles operator<<=', () => { expect(demangle("_ZN6NumberlSERKS_")).toBe("Number::operator<<=(const Number&)"); });
    it('handles operator>>=', () => { expect(demangle("_ZN6NumberrSERKS_")).toBe("Number::operator>>=(const Number&)"); });
  });

  describe('logical and increment operators', () => {
    it('handles operator!',  () => { expect(demangle("_ZN6NumberntEv")).toBe("Number::operator!()"); });
    it('handles operator&&', () => { expect(demangle("_ZN6NumberaaERKS_")).toBe("Number::operator&&(const Number&)"); });
    it('handles operator||', () => { expect(demangle("_ZN6NumberooERKS_")).toBe("Number::operator||(const Number&)"); });
    it('handles operator++', () => { expect(demangle("_ZN6NumberppEv")).toBe("Number::operator++()"); });
    it('handles operator--', () => { expect(demangle("_ZN6NumbermmEv")).toBe("Number::operator--()"); });
  });

  describe('special operators', () => {
    it('handles operator()',  () => { expect(demangle("_ZN7FunctorclEi")).toBe("Functor::operator()(int)"); });
    it('handles operator[]',  () => { expect(demangle("_ZN5ArrayixEi")).toBe("Array::operator[](int)"); });
    it('handles operator->',  () => { expect(demangle("_ZN7PointerptEv")).toBe("Pointer::operator->()"); });
    it('handles operator->*', () => { expect(demangle("_ZN7PointerpmEi")).toBe("Pointer::operator->*(int)"); });
    it('handles operator,',   () => { expect(demangle("_ZN6NumbercmERKS_")).toBe("Number::operator,(const Number&)"); });
  });

  describe('memory operators', () => {
    it('handles operator new',      () => { expect(demangle("_ZN6ObjectnwEm")).toBe("Object::operator new(unsigned long)"); });
    it('handles operator new[]',    () => { expect(demangle("_ZN6ObjectnaEm")).toBe("Object::operator new[](unsigned long)"); });
    it('handles operator delete',   () => { expect(demangle("_ZN6ObjectdlEPv")).toBe("Object::operator delete(void*)"); });
    it('handles operator delete[]', () => { expect(demangle("_ZN6ObjectdaEPv")).toBe("Object::operator delete[](void*)"); });
  });

  describe('unary operators', () => {
    it('handles unary operator+',             () => { expect(demangle("_ZN6NumberpsEv")).toBe("Number::operator+()"); });
    it('handles unary operator-',             () => { expect(demangle("_ZN6NumberngEv")).toBe("Number::operator-()"); });
    it('handles unary operator& (address-of)', () => { expect(demangle("_ZN6NumberadEv")).toBe("Number::operator&()"); });
    it('handles unary operator* (dereference)', () => { expect(demangle("_ZN7PointerdeEv")).toBe("Pointer::operator*()"); });
  });
});

describe('constructors and destructors', () => {
  it('handles constructor', () => {
    expect(demangle("_ZN6VectorC1Ev")).toBe("Vector::Vector()");
  });
  it('handles constructor with parameters', () => {
    expect(demangle("_ZN6VectorC1Eii")).toBe("Vector::Vector(int, int)");
  });
  it('handles destructor', () => {
    expect(demangle("_ZN6VectorD1Ev")).toBe("Vector::~Vector()");
  });
  it('handles copy constructor', () => {
    expect(demangle("_ZN6VectorC1ERKS_")).toBe("Vector::Vector(const Vector&)");
  });
});

describe('const member functions', () => {
  it('handles const member function', () => {
    expect(demangle("_ZNK6Vector4sizeEv")).toBe("Vector::size() const");
  });
  it('handles const member function with parameters', () => {
    expect(demangle("_ZNK6Vector2atEi")).toBe("Vector::at(int) const");
  });
});

describe('static and const qualifiers', () => {
  it('handles pointer to pointer to const', () => {
    expect(demangle("_Z8testPtrsPPKi")).toBe("testPtrs(const int**)");
  });
});

describe('template functions', () => {
  it('handles simple template function', () => {
    expect(demangle("_Z3maxIiET_S0_S0_")).toBe("int max<int>(int, int)");
  });
  it('handles template with multiple types', () => {
    expect(demangle("_Z4swapIiEvRT_S1_")).toBe("void swap<int>(int&, int&)");
  });
  it('handles complex templated member function', () => {
    expect(demangle("_ZN3std6vectorIiSaIiEE9push_backERKi")).toBe("std::vector<int, std::allocator<int>>::push_back(const int&)");
  });
});

describe('array types', () => {
  it('handles simple array', () => {
    expect(demangle("_Z9testArrayA10_i")).toBe("testArray(int[10])");
  });
  it('handles multidimensional arrays', () => {
    expect(demangle("_Z11test2DArrayA10_A20_i")).toBe("test2DArray(int[10][20])");
  });
});

describe('function pointers', () => {
  it('handles function pointer parameter', () => {
    expect(demangle("_Z8callbackPFviE")).toBe("callback(void (*)(int))");
  });
  it('handles pointer to member function', () => {
    expect(demangle("_Z10testMemberiM6VectorKFvvE")).toBe("testMember(int, void (Vector::*)() const)");
  });
});

describe('complex substitutions', () => {
  it('handles multiple back-references', () => {
    expect(demangle("_Z8functionN3foo3barES0_S0_")).toBe("function(foo::bar, foo::bar, foo::bar)");
  });
  it('handles nested type substitutions', () => {
    expect(demangle("_ZN6Vector4pushERKS_")).toBe("Vector::push(const Vector&)");
  });
});

describe('edge cases', () => {
  it('handles isMangled check for non-mangled name', () => {
    expect(isMangled("regularFunction")).toBe(false);
  });
  it('handles isMangled check for mangled name', () => {
    expect(isMangled("_Z5isInti")).toBe(true);
  });
  it('demangles templated type in anonymous namespace', () => {
    expect(demangle("_ZN12_GLOBAL__N_128gtest_suite_PrimeTableTest2_24ReturnsFalseForNonPrimesI18OnTheFlyPrimeTableE8TestBodyEv")).toBe(
      "(anonymous namespace)::gtest_suite_PrimeTableTest2_::ReturnsFalseForNonPrimes<OnTheFlyPrimeTable>::TestBody()");
  });
  it('handles vendor-specific suffix with dot', () => {
    expect(demangle("_Z5isInti.constprop.0")).toBe("isInt(int)");
  });
  it('handles empty parameter list explicitly', () => {
    expect(demangle("_Z8functionv")).toBe("function()");
  });
  it('handles very long names', () => {
    expect(demangle("_Z49thisIsAVeryLongFunctionNameWithManyCharactersInItv")).toBe(
      "thisIsAVeryLongFunctionNameWithManyCharactersInIt()");
  });
});

describe('error handling and edge cases', () => {
  it('handles malformed nested namespace', () => {
    expect(demangle("_ZN")).toBe("()");
  });
  it('handles empty segment in namespace', () => {
    expect(demangle("_ZNE")).toBe("()");
  });
  it('handles invalid segment start character', () => {
    expect(demangle("_ZN#E")).toBe("()");
  });
  it('handles template parameter with no params available', () => {
    expect(demangle("_Z3fooT_")).toBe("foo()");
  });
  it('handles template parameter index out of bounds', () => {
    expect(demangle("_Z3fooT9_")).toBe("foo(_)");
  });
  it('handles unknown std type code', () => {
    expect(demangle("_Z3fooSz")).toBe("foo(...)");
  });
  it('handles substitution with empty substitutions array', () => {
    expect(demangle("_Z3fooS_")).toBe("foo()");
  });
  it('handles substitution index out of bounds', () => {
    expect(demangle("_Z3fooS99_")).toBe("foo(_)");
  });
  it('handles array type without valid element type', () => {
    expect(demangle("_Z3fooA5_")).toBe("foo(_)");
  });
  it('handles function pointer without valid return type', () => {
    expect(demangle("_Z3fooPF")).toBe("foo()");
  });
  it('handles member function pointer without class type', () => {
    expect(demangle("_Z3fooM")).toBe("foo()");
  });
  it('handles member function pointer missing F marker', () => {
    expect(demangle("_Z3fooM3Bar")).toBe("foo(Bar)");
  });
  it('handles member function pointer without return type', () => {
    expect(demangle("_Z3fooM3BarF")).toBe("foo(Bar)");
  });
  it('handles unknown type code', () => {
    expect(demangle("_Z3fooQ")).toBe("foo()");
  });
  it('handles template type on TypeInfo', () => {
    expect(demangle("_Z3fooRi")).toBe("foo(int&)");
  });
  it('handles malformed operator code', () => {
    expect(demangle("_ZN3FoozzEv")).toBe("Foo(..., ..., void)");
  });
  it('handles function pointer type', () => {
    expect(demangle("_Z3fooPFiE")).toBe("foo(int (*)())");
  });
  it('handles parseTemplateIfPresent with non-digit after I', () => {
    expect(demangle("_Z3fooIiE")).toBe("foo<int>()");
  });
  it('handles std::string type code', () => {
    expect(demangle("_Z3fooSs")).toBe("foo(std::basic_string<char, std::char_traits<char>, std::allocator<char>>)");
  });
  it('handles parseStdType with digit (std:: custom)', () => {
    expect(demangle("_Z3fooS6vector")).toBe("foo(std::vector)");
  });
  it('explicitly encodes return type for template functions taking parameters', () => {
    expect(demangle("_Z5firstI3DuoEvS0_")).toBe("void first<Duo>(Duo)");
  });
  it('explicitly encodes return type for template functions with no parameters', () => {
    expect(demangle("_Z3fooIiPFidEiEvv")).toBe("void foo<int, int (*)(double), int>()");
  });
  it('handles pointers to member data', () => {
    expect(demangle("_Z3fooPM2ABi")).toBe("foo(int AB::**)");
  });
});

describe('special names (typeinfo, vtable, etc.)', () => {
  it('handles typeinfo (TI)',         () => { expect(demangle("_ZTI7MyClass")).toBe("typeinfo for MyClass"); });
  it('handles typeinfo name (TS)',     () => { expect(demangle("_ZTS7MyClass")).toBe("typeinfo name for MyClass"); });
  it('handles vtable (TV)',            () => { expect(demangle("_ZTV7MyClass")).toBe("vtable for MyClass"); });
  it('handles VTT (TT)',               () => { expect(demangle("_ZTT7MyClass")).toBe("VTT for MyClass"); });
  it('handles construction vtable (TC)', () => { expect(demangle("_ZTC7MyClass")).toBe("construction vtable for MyClass"); });
  it('handles guard variable (GV)',    () => { expect(demangle("_ZGVN7MyClass10staticDataE")).toBe("guard variable for MyClass::staticData"); });
  it('handles TLS init function (TH)', () => { expect(demangle("_ZTH7MyClass")).toBe("TLS init function for MyClass"); });
  it('handles TLS wrapper function (TW)', () => { expect(demangle("_ZTW7MyClass")).toBe("TLS wrapper function for MyClass"); });
  it('handles typeinfo for namespaced class', () => { expect(demangle("_ZTIN3std6vectorE")).toBe("typeinfo for std::vector"); });
  it('handles vtable for nested class', () => { expect(demangle("_ZTVN5outer5inner5ClassE")).toBe("vtable for outer::inner::Class"); });
  it('handles typeinfo name for complex type', () => { expect(demangle("_ZTSN11myNamespace12MyCustomTypeE")).toBe("typeinfo name for myNamespace::MyCustomType"); });
  it('handles guard variable for namespaced static', () => { expect(demangle("_ZGVN4test10staticDataE")).toBe("guard variable for test::staticData"); });
});
