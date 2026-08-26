# Python基础入门

> 来源：北梦测·面试题库  
> 题目数：10

---

## 1. pyton中list和tuple的区别

### 参考答案

1. list是用方括号[]表示，tuple使用小括号()表示
 2. list中的值是可以改变的，tuple的值不可以改变，所以tuple没有insert, pop,append方法

---

## 2. python中数据类型行都有哪些

### 参考答案

1. 字符串（string），可以用单引号，双引号和三引号
2. 布尔类型（bool），True，False
3. 整型，int
4. 浮点数（float）
5. 数字（number），包含整型和浮点型
6. 列表（list），使用[]，其中的值可以改变
7. 元组（tuple），使用（）,其中的值不可以改变
8. 字典（dict），key:value形式
9. 集合（set），无序，不重复的序列，使用{ }
9. 日期（date）

---

## 3. python的切片操作

### 参考答案

a = [0,1,2,3,4,5,6,7,8,9]
1. 切取单个元素
1.a[0] = [0]
2. 切取完整对象
1.a[:] = [0,1,2,3,4,5,6,7,8,9]
3. 开始：结束
1.a[0:3] = [0,1,2] (包左不包右)
4. 开始：结束：步长
1.a[0:5:2] = [0,2,4]

---

## 4. 冒泡排序算法

### 参考答案

冒泡排序（Bubble Sort），是一种计算机科学领域的较简单的排序算法。
它重复地走访过要排序的数列，一次比较两个元素，如果他们的顺序错误就把他们交换过来。走访数列的工作是重复地进行直到没有再需要交换，也就是说该数列已经排序完成。
这个算法的名字由来是因为越大的元素会经由交换慢慢“浮”到数列的顶端，故名冒泡排序。
以上是百度词条对冒泡排序的官方解释。
但是我要说一下我的个人理解，我觉得冒泡排序的核心思想是：每次比较两个数，如果他们顺序错误（大于或者小于），那么就把他们置换。
例如：如果要将五个无序的数字做升序排列（也就是从小到大排列），那么利用冒泡排序如何实现呢？
1.首先，比较第一个数和第二个数的大小，由于是从小到大排列，所以如果第一个数大于第二个数，则将这两个数互换位置，反之则不变。
2.然后进行第二个数和第三个数比较，同上。
3.这样依次比较一轮后，你会发现，总共比了4次，也就是说，如果有n个数进行比较，那么需要n-1次才能完成。
4.上面过程主要完成了一轮比较，最终确定了一个最大的数，并且排在5个数的最后，也就是第五个数。
5.那么也就意味着需要在进行第一个数到第四个数的一轮比较，确定最大值。
6.接着从第一个数到第三个数......
7.这样规律就很明显了，五个数需要比较四轮，就能将5个数升序排列，所以n个数需要比较n-1轮。

# 方法1
# 定义一个列表，用于存放数字
list = []
while True:
  # 自定义输入数字个数
  print('你想排列几个数？')
  try:
    num = int(input())
    for i in range(num):
      a = int(input('请输入第' + str((i+1)) + '个整数：'))
      list.append(a)
  except ValueError:
    print('输入有误！')

  # 冒泡排序核心代码，
  for j in range(len(list)-1):
    for k in range(len(list)-1):
      if list[k] < list[k+1]:
        t = list[k]
        list[k] = list[k+1]
        list[k+1] = t

  print(list)

# 定义一个列表对象存数字
list = []
print('你想排列几个数？')
try:
  num = int(input())
  for i in range(num):
    a = int(input('请输入第' + str((i + 1)) + '个整数：'))
    list.append(a)
except ValueError:
  print('输入有误！')

# 利用sorted()方法排序，并使用reverse字段实现降序
print(sorted(list, reverse=True))

---

## 5. 你常用到的python的内置模块（库）有哪些

### 参考答案

1. time，使用其中的sleep方法作为等待时间，转换时间格式等
 2. Random，生成随机的内容
 3. sys，系统模块，获取系统的path路径，系统版本等
 4. os，是与操作系统交互的一个模块，可以获取当前的绝对路径，文件名等
 5. json，进行json数据的处理
 6. unittest，python自带的单元测试框架，我们一般在自动化测试用会使用它，组织和执行测试用例，生成报告。
 7.logging，python自带的日志模块，可以向工作台或者文件中输出日志信息

---

## 6. 了解python中的lambda表达式么？

### 参考答案

python中的lambda表达式也叫匿名函数，及函数没有具体的额名称。Lambda表达式是python中一类特殊的定义函数的形式，使用它可以定义一个匿名函数。
 lambda表达式的函数体只能有单独的一条语句，也就是返回值表达式语句。
 Lambda表达式，通常是在需要一个函数，但是又不想费神去命名一个函数的场合下使用。
 举个简单的例子，求两数相加的和：
 # 这是一个简单的lambda表达式
sum = lambda a,b: a+b
sum(1,3)

---

## 7. 在python如何去遍历字典？

### 参考答案

一共有三种遍历的方法，最重要的一种是遍历字典的key和value
1. 遍历字典的键值对
dict1 = {"a": 1, "b": 2, "c": 3}
for key, value in dict1.items():
    print(key, value)
输出：
a 1
b 2
c 3
2. 遍历字典的key
dict1 = {"a": 1, "b": 2, "c": 3}
for key in dict1.keys():
    print(key)
keys = dict1.keys()
print(keys)

输出：
a
b
c
abc
3. 遍历字典的value
dict1 = {"a": 1, "b": 2, "c": 3}
for value in dict1.values():
    print(value)
输出：
1
2
3

---

## 8. python常用的库和库的作用

### 参考答案

selenium
requests
allure
pytest
PIL：图像识别工具类封装（图片上写的是不是对应文字，图片或者组件颜色），和图像有光的都可以使用。
cv2：opencv --颜色识别工具类
range：for num in range(5) 循环5次
random：
 random.randint(0, 99)-->随机0~99的整数
 random.random()-->(0~1)随机0~1的浮点数
 生成一些随机的数据，随机的文件名，或者密码等
time：生成现在的时间戳，time.sleep睡眠几秒种
datetime：格式化时间-"%Y%m%d %H%M%S  特定的格式
等等
os：系统配置信息
os.name ：获取操作系统的名称类型
os.environ['PATH']：获取环境变量中path的值，environ返回的是所有环境变量的字典
os.getcwd() 获取工作目录的绝对路径

---

## 9. python中，list如何添加一个数据，如何添加一个list

### 参考答案

1. list加一个数据：
list.append("data")
2. list+一个list的操作
list1.extend(list2)或者 list1+list2 都可以做到list+list的操作

---

## 10. 列表推导式

### 参考答案

生成平方列表：
numbers = [1, 2, 3, 4, 5]
squares = [x**2 for x in numbers]
print(squares)  # 输出: [1, 4, 9, 16, 25]

---
