(module
 (func $foo (param $a i32) (param $b i32) (result i32)
       (local $x i32)
       (local.set $x (i32.mul (local.get $a) (local.get $b)))
       (i32.add (local.get $b)
		(i32.sub (i32.mul (local.get $x) (i32.const 3))
			 (local.get $a))))
 (export "foo" (func $foo)))
		
